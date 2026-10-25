"""Catalog and edit-lease API for the private-data deployment."""

from __future__ import annotations

import json
import os
import secrets
import uuid
from datetime import UTC, datetime, timedelta
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from geolibre_server_api.auth import AuthPrincipal, get_session, require_data_scope
from geolibre_server_api.catalog_models import (
    CatalogDataset,
    CatalogEditLease,
    CatalogFolder,
    CatalogRevision,
    CatalogProcessingJob,
    CatalogUpload,
)

READ_DATA = Annotated[AuthPrincipal, Depends(require_data_scope("read:data"))]
WRITE_DATA = Annotated[AuthPrincipal, Depends(require_data_scope("write:data"))]


def timestamp() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def expires_at(minutes: int = 30) -> str:
    return (datetime.now(UTC) + timedelta(minutes=minutes)).isoformat().replace("+00:00", "Z")

def allowed_buckets() -> set[str]:
    return {value.strip() for value in os.getenv("GEOLIBRE_S3_BUCKETS", "").split(",") if value.strip()}

def s3_client():
    try:
        import boto3
    except ImportError as exc:
        raise HTTPException(503, "S3 access is not installed") from exc
    try:
        return boto3.client(
            "s3", region_name=os.getenv("AWS_REGION") or os.getenv("AWS_DEFAULT_REGION")
        )
    except Exception as exc:
        raise HTTPException(503, "S3 access is unavailable") from exc


def presigned_read_url(bucket: str, key: str, expires_in: int = 900) -> str:
    if bucket not in allowed_buckets():
        raise HTTPException(403, "dataset bucket is not allowed")
    try:
        return s3_client().generate_presigned_url(
            "get_object", Params={"Bucket": bucket, "Key": key}, ExpiresIn=expires_in
        )
    except Exception as exc:
        raise HTTPException(503, "S3 access is unavailable") from exc


class FolderCreate(BaseModel):
    display_name: str = Field(min_length=1, max_length=200)
    parent_id: str | None = None


class FolderJson(BaseModel):
    id: str
    parent_id: str | None
    display_name: str
    logical_path: str
    storage_prefix: str


class RevisionJson(BaseModel):
    id: str
    s3_bucket: str
    s3_key: str
    s3_version_id: str | None
    etag: str | None
    size_bytes: int | None
    source_revision_id: str | None
    created_by: str
    created_at: str
    status: str
    model_config = {"from_attributes": True}


class DatasetCreate(BaseModel):
    folder_id: str
    display_name: str = Field(min_length=1, max_length=255)
    format: str = Field(min_length=1, max_length=32)
    description: str = Field(default="", max_length=4000)
    s3_bucket: str = Field(min_length=3, max_length=255)
    s3_key: str = Field(min_length=1, max_length=2000)
    s3_version_id: str | None = Field(default=None, max_length=255)
    etag: str | None = Field(default=None, max_length=255)
    size_bytes: int | None = Field(default=None, ge=0)


class DatasetJson(BaseModel):
    id: str
    folder_id: str
    display_name: str
    format: str
    description: str
    created_by: str
    created_at: str
    updated_at: str
    current_revision_id: str | None


class DatasetDetail(DatasetJson):
    revisions: list[RevisionJson]


class LeaseJson(BaseModel):
    dataset_id: str
    revision_id: str
    lease_token: str
    expires_at: str


class CatalogPage(BaseModel):
    items: list[DatasetJson]
    limit: int
    offset: int
    has_more: bool

class ReadAccessJson(BaseModel):
    url: str
    expires_at: str

class UploadCreate(BaseModel):
    folder_id: str
    filename: str = Field(min_length=1, max_length=255)
    content_type: str = Field(min_length=1, max_length=255)
    size_bytes: int = Field(gt=0)
    format: str = Field(min_length=1, max_length=32)
    dataset_id: str | None = None
    lease_token: str | None = Field(default=None, max_length=64)

class UploadJson(BaseModel):
    id: str
    key: str
    content_type: str
    size_bytes: int
    url: str
    fields: dict[str, str]
    expires_at: str


class UploadCompleteJson(BaseModel):
    dataset: DatasetDetail


class JobCreate(BaseModel):
    dataset_id: str
    operation: str = Field(min_length=1, max_length=64)
    parameters: dict[str, object] = Field(default_factory=dict)


class JobJson(BaseModel):
    id: str
    dataset_id: str
    input_revision_id: str
    operation: str
    parameters: dict[str, object]
    output_revision_id: str | None
    status: str
    error: str | None
    created_at: str
    completed_at: str | None


def folder_json(folder: CatalogFolder) -> FolderJson:
    return FolderJson(
        id=folder.id,
        parent_id=folder.parent_id,
        display_name=folder.display_name,
        logical_path=folder.logical_path,
        storage_prefix=folder.storage_prefix,
    )


def dataset_json(dataset: CatalogDataset) -> DatasetJson:
    return DatasetJson(
        id=dataset.id,
        folder_id=dataset.folder_id,
        display_name=dataset.display_name,
        format=dataset.format,
        description=dataset.description,
        created_by=dataset.created_by,
        created_at=dataset.created_at,
        updated_at=dataset.updated_at,
        current_revision_id=dataset.current_revision_id,
    )


def router() -> APIRouter:
    api = APIRouter(prefix="/api/catalog", tags=["catalog"])

    @api.get("/folders", response_model=list[FolderJson])
    def list_folders(
        principal: READ_DATA,
        session: Session = Depends(get_session),
        parent_id: str | None = Query(default=None),
    ) -> list[FolderJson]:
        del principal
        folders = session.scalars(
            select(CatalogFolder)
            .where(CatalogFolder.parent_id == parent_id)
            .order_by(CatalogFolder.logical_path)
        )
        return [folder_json(folder) for folder in folders]

    @api.post("/folders", response_model=FolderJson, status_code=201)
    def create_folder(
        request: FolderCreate,
        principal: WRITE_DATA,
        session: Session = Depends(get_session),
    ) -> FolderJson:
        del principal
        parent = session.get(CatalogFolder, request.parent_id) if request.parent_id else None
        if request.parent_id and parent is None:
            raise HTTPException(404, "parent folder not found")
        name = request.display_name.strip()
        if "/" in name or name in {".", ".."}:
            raise HTTPException(422, "folder name must not contain slash or path traversal")
        logical_path = f"{parent.logical_path}/{name}" if parent else name
        storage_prefix = f"{parent.storage_prefix}{name}/" if parent else f"incoming/{name}/"
        folder = CatalogFolder(
            id=str(uuid.uuid4()),
            parent_id=parent.id if parent else None,
            display_name=name,
            logical_path=logical_path,
            storage_prefix=storage_prefix,
            created_at=timestamp(),
        )
        session.add(folder)
        try:
            session.commit()
        except Exception:
            session.rollback()
            raise HTTPException(409, "folder already exists")
        return folder_json(folder)

    @api.post("/uploads", response_model=UploadJson, status_code=201)
    def create_upload(
        request: UploadCreate,
        principal: WRITE_DATA,
        session: Session = Depends(get_session),
    ) -> UploadJson:
        folder = session.get(CatalogFolder, request.folder_id)
        if folder is None:
            raise HTTPException(404, "folder not found")
        dataset = session.get(CatalogDataset, request.dataset_id) if request.dataset_id else None
        if request.dataset_id:
            if dataset is None or dataset.folder_id != folder.id:
                raise HTTPException(404, "dataset not found")
            lease = session.get(CatalogEditLease, dataset.id)
            if (
                lease is None
                or lease.principal_id != principal.account.id
                or lease.lease_token != request.lease_token
                or lease.expires_at <= timestamp()
                or lease.revision_id != dataset.current_revision_id
            ):
                raise HTTPException(409, "valid edit lease required")
        source_revision_id = dataset.current_revision_id if dataset is not None else None
        filename = request.filename.strip()
        if not filename or "/" in filename or "\\" in filename or filename in {".", ".."}:
            raise HTTPException(422, "invalid filename")
        max_bytes = int(os.getenv("GEOLIBRE_MAX_UPLOAD_BYTES", str(250 * 1024 * 1024)))
        if request.size_bytes > max_bytes:
            raise HTTPException(413, "upload exceeds the configured size limit")
        bucket = os.getenv("GEOLIBRE_S3_WRITE_BUCKET", "").strip()
        if not bucket or bucket not in allowed_buckets():
            raise HTTPException(503, "S3 upload bucket is not configured")
        upload_id = str(uuid.uuid4())
        key = f"{folder.storage_prefix}{dataset.id if dataset is not None else upload_id}/{upload_id}-{filename}"
        try:
            post = s3_client().generate_presigned_post(
                Bucket=bucket,
                Key=key,
                Fields={"Content-Type": request.content_type},
                Conditions=[
                    {"Content-Type": request.content_type},
                    ["content-length-range", request.size_bytes, request.size_bytes + 16 * 1024],
                ],
                ExpiresIn=900,
            )
        except Exception as exc:
            raise HTTPException(503, "S3 upload is unavailable") from exc
        created = timestamp()
        session.add(
            CatalogUpload(
                id=upload_id,
                folder_id=folder.id,
                dataset_id=dataset.id if dataset is not None else None,
                source_revision_id=source_revision_id,
                lease_token=request.lease_token,
                principal_id=principal.account.id,
                filename=filename,
                content_type=request.content_type,
                size_bytes=request.size_bytes,
                s3_bucket=bucket,
                s3_key=key,
                status="issued",
                created_at=created,
            )
        )
        session.commit()
        return UploadJson(
            id=upload_id,
            key=key,
            content_type=request.content_type,
            size_bytes=request.size_bytes,
            url=post["url"],
            fields={str(name): str(value) for name, value in post["fields"].items()},
            expires_at=(datetime.now(UTC) + timedelta(minutes=15)).isoformat().replace("+00:00", "Z"),
        )

    @api.post("/uploads/{upload_id}/complete", response_model=UploadCompleteJson)
    def complete_upload(
        upload_id: str,
        principal: WRITE_DATA,
        session: Session = Depends(get_session),
    ) -> UploadCompleteJson:
        upload = session.get(CatalogUpload, upload_id)
        if upload is None or upload.principal_id != principal.account.id:
            raise HTTPException(404, "upload not found")
        if upload.status != "issued":
            raise HTTPException(409, "upload is not pending")
        try:
            head = s3_client().head_object(Bucket=upload.s3_bucket, Key=upload.s3_key)
        except Exception as exc:
            raise HTTPException(409, "uploaded object is not available") from exc
        if int(head.get("ContentLength", -1)) != upload.size_bytes:
            raise HTTPException(422, "uploaded object size does not match the request")
        if upload.dataset_id:
            dataset = session.get(CatalogDataset, upload.dataset_id)
            lease = session.get(CatalogEditLease, upload.dataset_id)
            if (
                dataset is None
                or lease is None
                or lease.principal_id != principal.account.id
                or lease.lease_token != upload.lease_token
                or lease.revision_id != upload.source_revision_id
                or dataset.current_revision_id != upload.source_revision_id
            ):
                raise HTTPException(409, "edit lease or source revision is no longer valid")
            created = timestamp()
            revision = CatalogRevision(
                id=str(uuid.uuid4()),
                dataset=dataset,
                s3_bucket=upload.s3_bucket,
                s3_key=upload.s3_key,
                s3_version_id=head.get("VersionId"),
                etag=str(head.get("ETag", "")).strip('"') or None,
                size_bytes=upload.size_bytes,
                source_revision_id=upload.source_revision_id,
                created_by=principal.account.id,
                created_at=created,
                status="complete",
            )
            dataset.current_revision_id = revision.id
            dataset.updated_at = created
            upload.status = "complete"
            session.delete(lease)
            session.commit()
            session.refresh(dataset)
            return UploadCompleteJson(
                dataset=DatasetDetail(
                    **dataset_json(dataset).model_dump(),
                    revisions=[RevisionJson.model_validate(revision, from_attributes=True)],
                )
            )

        created = timestamp()
        dataset = CatalogDataset(
            id=str(uuid.uuid4()),
            folder_id=upload.folder_id,
            display_name=upload.filename,
            format=upload.filename.rsplit(".", 1)[-1].lower() if "." in upload.filename else "other",
            created_by=principal.account.id,
            created_at=created,
            updated_at=created,
        )
        revision = CatalogRevision(
            id=str(uuid.uuid4()),
            dataset=dataset,
            s3_bucket=upload.s3_bucket,
            s3_key=upload.s3_key,
            s3_version_id=head.get("VersionId"),
            etag=str(head.get("ETag", "")).strip('"') or None,
            size_bytes=upload.size_bytes,
            created_by=principal.account.id,
            created_at=created,
            status="complete",
        )
        dataset.current_revision_id = revision.id
        upload.status = "complete"
        session.add(dataset)
        session.commit()
        session.refresh(dataset)
        return UploadCompleteJson(
            dataset=DatasetDetail(
                **dataset_json(dataset).model_dump(),
                revisions=[RevisionJson.model_validate(revision, from_attributes=True)],
            )
        )

    @api.post("/jobs", response_model=JobJson, status_code=202)
    def create_job(
        job_request: JobCreate,
        principal: WRITE_DATA,
        http_request: Request,
        session: Session = Depends(get_session),
    ) -> JobJson:
        dataset = session.get(CatalogDataset, job_request.dataset_id)
        if dataset is None or dataset.current_revision_id is None:
            raise HTTPException(404, "dataset or current revision not found")
        if job_request.operation not in {"raster.clip", "raster.reproject", "raster.cog"}:
            raise HTTPException(422, "unsupported raster operation")
        created = timestamp()
        job = CatalogProcessingJob(
            id=str(uuid.uuid4()),
            dataset_id=dataset.id,
            input_revision_id=dataset.current_revision_id,
            operation=job_request.operation,
            parameters_json=json.dumps(job_request.parameters, separators=(",", ":")),
            status="queued",
            created_by=principal.account.id,
            created_at=created,
        )
        session.add(job)
        session.commit()
        from geolibre_server_api.processing_worker import enqueue_catalog_job
        enqueue_catalog_job(
            http_request.app.state.catalog_job_executor,
            http_request.app.state.session_factory,
            job.id,
        )
        return JobJson(
            id=job.id,
            dataset_id=job.dataset_id,
            input_revision_id=job.input_revision_id,
            operation=job.operation,
            parameters=job_request.parameters,
            output_revision_id=job.output_revision_id,
            status=job.status,
            error=job.error,
            created_at=job.created_at,
            completed_at=job.completed_at,
        )

    @api.get("/jobs/{job_id}", response_model=JobJson)
    def get_job(
        job_id: str,
        principal: READ_DATA,
        session: Session = Depends(get_session),
    ) -> JobJson:
        job = session.get(CatalogProcessingJob, job_id)
        if job is None:
            raise HTTPException(404, "job not found")
        return JobJson(
            id=job.id,
            dataset_id=job.dataset_id,
            input_revision_id=job.input_revision_id,
            operation=job.operation,
            parameters=json.loads(job.parameters_json),
            output_revision_id=job.output_revision_id,
            status=job.status,
            error=job.error,
            created_at=job.created_at,
            completed_at=job.completed_at,
        )

    @api.get("/datasets", response_model=CatalogPage)
    def list_datasets(
        principal: READ_DATA,
        session: Session = Depends(get_session),
        q: str | None = Query(default=None, max_length=255),
        folder_id: str | None = None,
        format: str | None = Query(default=None, max_length=32),
        limit: int = Query(default=50, ge=1, le=200),
        offset: int = Query(default=0, ge=0),
    ) -> CatalogPage:
        del principal
        statement = select(CatalogDataset)
        filters = []
        if q:
            pattern = f"%{q.strip()}%"
            filters.append(or_(CatalogDataset.display_name.ilike(pattern), CatalogDataset.description.ilike(pattern)))
        if folder_id:
            filters.append(CatalogDataset.folder_id == folder_id)
        if format:
            filters.append(CatalogDataset.format == format.lower())
        if filters:
            statement = statement.where(*filters)
        rows = list(
            session.scalars(
                statement.order_by(CatalogDataset.updated_at.desc()).offset(offset).limit(limit + 1)
            )
        )
        return CatalogPage(
            items=[dataset_json(dataset) for dataset in rows[:limit]],
            limit=limit,
            offset=offset,
            has_more=len(rows) > limit,
        )

    @api.post("/datasets", response_model=DatasetDetail, status_code=201)
    def create_dataset(
        request: DatasetCreate,
        principal: WRITE_DATA,
        session: Session = Depends(get_session),
    ) -> DatasetDetail:
        folder = session.get(CatalogFolder, request.folder_id)
        if folder is None:
            raise HTTPException(404, "folder not found")
        if request.s3_bucket not in allowed_buckets():
            raise HTTPException(403, "dataset bucket is not allowed")
        if ".." in request.s3_key.split("/") or request.s3_key.startswith("/"):
            raise HTTPException(422, "invalid object key")
        if not request.s3_key.startswith(folder.storage_prefix):
            raise HTTPException(422, "object key is outside the folder")
        created = timestamp()
        dataset = CatalogDataset(
            id=str(uuid.uuid4()),
            folder_id=folder.id,
            display_name=request.display_name.strip(),
            format=request.format.lower(),
            description=request.description,
            created_by=principal.account.id,
            created_at=created,
            updated_at=created,
        )
        revision = CatalogRevision(
            id=str(uuid.uuid4()),
            dataset=dataset,
            s3_bucket=request.s3_bucket,
            s3_key=request.s3_key,
            s3_version_id=request.s3_version_id,
            etag=request.etag,
            size_bytes=request.size_bytes,
            created_by=principal.account.id,
            created_at=created,
            status="complete",
        )
        dataset.current_revision_id = revision.id
        session.add(dataset)
        session.commit()
        session.refresh(dataset)
        return DatasetDetail(
            **dataset_json(dataset).model_dump(),
            revisions=[RevisionJson.model_validate(revision, from_attributes=True)],
        )

    @api.get("/datasets/{dataset_id}", response_model=DatasetDetail)
    def get_dataset(
        dataset_id: str,
        principal: READ_DATA,
        session: Session = Depends(get_session),
    ) -> DatasetDetail:
        del principal
        dataset = session.get(CatalogDataset, dataset_id)
        if dataset is None:
            raise HTTPException(404, "dataset not found")
        return DatasetDetail(
            **dataset_json(dataset).model_dump(),
            revisions=[RevisionJson.model_validate(revision, from_attributes=True) for revision in dataset.revisions],
        )

    @api.get("/datasets/{dataset_id}/read-url", response_model=ReadAccessJson)
    def get_read_url(
        dataset_id: str,
        principal: READ_DATA,
        session: Session = Depends(get_session),
    ) -> ReadAccessJson:
        del principal
        dataset = session.get(CatalogDataset, dataset_id)
        if dataset is None or dataset.current_revision_id is None:
            raise HTTPException(404, "dataset not found")
        revision = session.get(CatalogRevision, dataset.current_revision_id)
        if revision is None or revision.status != "complete":
            raise HTTPException(409, "current revision is unavailable")
        return ReadAccessJson(
            url=presigned_read_url(revision.s3_bucket, revision.s3_key),
            expires_at=(datetime.now(UTC) + timedelta(minutes=15)).isoformat().replace("+00:00", "Z"),
        )

    @api.post("/datasets/{dataset_id}/edit-lease", response_model=LeaseJson)
    def acquire_lease(
        dataset_id: str,
        principal: WRITE_DATA,
        session: Session = Depends(get_session),
    ) -> LeaseJson:
        dataset = session.get(CatalogDataset, dataset_id)
        if dataset is None:
            raise HTTPException(404, "dataset not found")
        if dataset.current_revision_id is None:
            raise HTTPException(409, "dataset has no current revision")
        current = dataset.lease
        now_value = timestamp()
        if current is not None and current.expires_at > now_value and current.principal_id != principal.account.id:
            raise HTTPException(409, "dataset is being edited by another user")
        if current is not None:
            session.delete(current)
        lease = CatalogEditLease(
            dataset_id=dataset.id,
            principal_id=principal.account.id,
            revision_id=dataset.current_revision_id,
            lease_token=secrets.token_urlsafe(32),
            expires_at=expires_at(),
            heartbeat_at=now_value,
        )
        session.add(lease)
        session.commit()
        return LeaseJson(
            dataset_id=lease.dataset_id,
            revision_id=lease.revision_id,
            lease_token=lease.lease_token,
            expires_at=lease.expires_at,
        )

    @api.delete("/datasets/{dataset_id}/edit-lease", status_code=204)
    def release_lease(
        dataset_id: str,
        principal: WRITE_DATA,
        session: Session = Depends(get_session),
    ) -> None:
        lease = session.get(CatalogEditLease, dataset_id)
        if lease is None:
            return
        if lease.principal_id != principal.account.id:
            raise HTTPException(403, "edit lease belongs to another user")
        session.delete(lease)
        session.commit()

    return api
