"""Background execution for catalog GeoTIFF jobs.

Jobs use the ECS task's S3 role, stage source objects in temporary storage, and
publish immutable catalog revisions. A queue service can call
``run_catalog_job`` later without changing the job contract.
"""

from __future__ import annotations

import json
import os
import tempfile
import uuid
from concurrent.futures import Executor
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from geolibre_server_api.catalog import allowed_buckets, s3_client
from geolibre_server_api.catalog_models import (
    CatalogDataset,
    CatalogFolder,
    CatalogProcessingJob,
    CatalogRevision,
)

SUPPORTED_RASTER_OPERATIONS = frozenset({"raster.clip", "raster.reproject", "raster.cog"})


def validate_raster_job(operation: str, parameters: dict[str, Any]) -> None:
    if operation not in SUPPORTED_RASTER_OPERATIONS:
        raise ValueError(f"unsupported raster operation: {operation}")
    if operation == "raster.clip":
        bbox = parameters.get("bbox")
        if not isinstance(bbox, list) or len(bbox) != 4:
            raise ValueError("raster.clip requires bbox=[left,bottom,right,top]")
        try:
            values = [float(value) for value in bbox]
        except (TypeError, ValueError) as exc:
            raise ValueError("raster.clip bbox must contain numbers") from exc
        if values[0] >= values[2] or values[1] >= values[3]:
            raise ValueError("raster.clip bbox must have positive width and height")
    elif operation == "raster.reproject":
        if not isinstance(parameters.get("dst_crs"), str) or not parameters["dst_crs"].strip():
            raise ValueError("raster.reproject requires dst_crs")


def timestamp() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def enqueue_catalog_job(executor: Executor, sessions: sessionmaker, job_id: str) -> None:
    executor.submit(run_catalog_job, sessions, job_id)


def run_catalog_job(sessions: sessionmaker, job_id: str) -> None:
    with sessions() as session:
        job = session.get(CatalogProcessingJob, job_id)
        if job is None or job.status != "queued":
            return
        job.status = "running"
        session.commit()
        try:
            output_revision_id = _execute_job(session, job)
            job.status = "succeeded"
            job.output_revision_id = output_revision_id
            job.completed_at = timestamp()
            job.error = None
            session.commit()
        except Exception as exc:
            session.rollback()
            failed = session.get(CatalogProcessingJob, job_id)
            if failed is not None:
                failed.status = "failed"
                failed.error = str(exc)[:4000]
                failed.completed_at = timestamp()
                session.commit()


def _execute_job(session: Session, job: CatalogProcessingJob) -> str:
    dataset = session.get(CatalogDataset, job.dataset_id)
    if dataset is None:
        raise RuntimeError("dataset not found")
    revision = session.get(CatalogRevision, job.input_revision_id)
    if revision is None or revision.status != "complete":
        raise RuntimeError("input revision is unavailable")
    if revision.s3_bucket not in allowed_buckets():
        raise RuntimeError("input bucket is not allowed")
    write_bucket = os.getenv("GEOLIBRE_S3_WRITE_BUCKET", "").strip()
    if not write_bucket or write_bucket not in allowed_buckets():
        raise RuntimeError("S3 output bucket is not configured")

    try:
        import rasterio
        from rasterio.enums import Resampling
        from rasterio.transform import from_bounds
        from rasterio.warp import calculate_default_transform, reproject
    except ImportError as exc:
        raise RuntimeError("raster processing requires rasterio") from exc

    parameters: dict[str, Any] = json.loads(job.parameters_json)
    validate_raster_job(job.operation, parameters)
    output_key = f"{_folder_prefix(session, dataset.id)}{dataset.id}/derived/{job.id}.tif"
    client = s3_client()

    with tempfile.TemporaryDirectory(prefix="geolibre-job-") as directory:
        source_path = Path(directory) / "source.tif"
        output_path = Path(directory) / "output.tif"
        client.download_file(revision.s3_bucket, revision.s3_key, str(source_path))

        if job.operation == "raster.clip":
            bbox = parameters["bbox"]
            with rasterio.open(source_path) as source:
                window = from_bounds(*[float(value) for value in bbox], transform=source.transform)
                window = window.round_offsets().round_lengths()
                if window.width <= 0 or window.height <= 0:
                    raise RuntimeError("clip extent does not intersect the raster")
                data = source.read(window=window)
                profile = source.profile.copy()
                profile.update(
                    width=data.shape[2],
                    height=data.shape[1],
                    transform=source.window_transform(window),
                )
                with rasterio.open(output_path, "w", **profile) as target:
                    target.write(data)
        elif job.operation == "raster.reproject":
            dst_crs = parameters["dst_crs"]
            with rasterio.open(source_path) as source:
                transform, width, height = calculate_default_transform(
                    source.crs, dst_crs, source.width, source.height, *source.bounds
                )
                profile = source.profile.copy()
                profile.update(crs=dst_crs, transform=transform, width=width, height=height)
                with rasterio.open(output_path, "w", **profile) as target:
                    for index in range(1, source.count + 1):
                        reproject(
                            source=rasterio.band(source, index),
                            destination=rasterio.band(target, index),
                            src_transform=source.transform,
                            src_crs=source.crs,
                            dst_transform=transform,
                            dst_crs=dst_crs,
                            resampling=Resampling.nearest,
                        )
        elif job.operation == "raster.cog":
            from rasterio.shutil import copy as copy_raster

            copy_raster(
                str(source_path),
                str(output_path),
                driver="COG",
                compress=str(parameters.get("compress", "DEFLATE")),
                blocksize=512,
            )
        else:
            raise RuntimeError(f"unsupported raster operation: {job.operation}")

        client.upload_file(
            str(output_path),
            write_bucket,
            output_key,
            ExtraArgs={"ContentType": "image/tiff"},
        )
        head = client.head_object(Bucket=write_bucket, Key=output_key)

    created = timestamp()
    output_revision = CatalogRevision(
        id=str(uuid.uuid4()),
        dataset=dataset,
        s3_bucket=write_bucket,
        s3_key=output_key,
        s3_version_id=head.get("VersionId"),
        etag=str(head.get("ETag", "")).strip('"') or None,
        size_bytes=int(head.get("ContentLength", 0)),
        source_revision_id=revision.id,
        created_by=job.created_by,
        created_at=created,
        status="complete",
    )
    dataset.current_revision_id = output_revision.id
    dataset.updated_at = created
    session.add(output_revision)
    session.flush()
    return output_revision.id


def _folder_prefix(session: Session, dataset_id: str) -> str:
    prefix = session.execute(
        select(CatalogFolder.storage_prefix)
        .join(CatalogDataset, CatalogDataset.folder_id == CatalogFolder.id)
        .where(CatalogDataset.id == dataset_id)
    ).scalar_one_or_none()
    return prefix or "derived/"
