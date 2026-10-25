"""Catalog, dataset revision, and edit-lease models for private data."""

from __future__ import annotations

from sqlalchemy import BigInteger, ForeignKey, Index, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from geolibre_server_api.auth_models import Base


class CatalogFolder(Base):
    __tablename__ = "catalog_folders"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    parent_id: Mapped[str | None] = mapped_column(
        ForeignKey("catalog_folders.id", ondelete="CASCADE"), nullable=True, index=True
    )
    display_name: Mapped[str] = mapped_column(String(200))
    logical_path: Mapped[str] = mapped_column(String(2000), unique=True)
    storage_prefix: Mapped[str] = mapped_column(String(2000), unique=True)
    created_at: Mapped[str] = mapped_column(String(32))
    folders: Mapped[list["CatalogFolder"]] = relationship(
        back_populates="parent", cascade="all, delete-orphan"
    )
    parent: Mapped["CatalogFolder | None"] = relationship(
        back_populates="folders", remote_side=[id]
    )


class CatalogDataset(Base):
    __tablename__ = "catalog_datasets"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    folder_id: Mapped[str] = mapped_column(
        ForeignKey("catalog_folders.id", ondelete="RESTRICT"), index=True
    )
    display_name: Mapped[str] = mapped_column(String(255))
    format: Mapped[str] = mapped_column(String(32))
    description: Mapped[str] = mapped_column(Text, default="")
    created_by: Mapped[str] = mapped_column(String(36), index=True)
    created_at: Mapped[str] = mapped_column(String(32))
    updated_at: Mapped[str] = mapped_column(String(32))
    current_revision_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    revisions: Mapped[list["CatalogRevision"]] = relationship(
        back_populates="dataset", cascade="all, delete-orphan", order_by="CatalogRevision.created_at"
    )
    lease: Mapped["CatalogEditLease | None"] = relationship(
        back_populates="dataset", cascade="all, delete-orphan", uselist=False
    )
    __table_args__ = (Index("ix_catalog_datasets_name", "display_name"),)


class CatalogRevision(Base):
    __tablename__ = "catalog_revisions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    dataset_id: Mapped[str] = mapped_column(
        ForeignKey("catalog_datasets.id", ondelete="CASCADE"), index=True
    )
    s3_bucket: Mapped[str] = mapped_column(String(255))
    s3_key: Mapped[str] = mapped_column(String(2000))
    s3_version_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    etag: Mapped[str | None] = mapped_column(String(255), nullable=True)
    size_bytes: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    source_revision_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    created_by: Mapped[str] = mapped_column(String(36), index=True)
    created_at: Mapped[str] = mapped_column(String(32))
    status: Mapped[str] = mapped_column(String(24), default="complete")
    dataset: Mapped[CatalogDataset] = relationship(back_populates="revisions")
    __table_args__ = (
        UniqueConstraint("s3_bucket", "s3_key", "s3_version_id", name="uq_catalog_revision_object"),
        Index("ix_catalog_revisions_dataset_created", "dataset_id", "created_at"),
    )


class CatalogEditLease(Base):
    __tablename__ = "catalog_edit_leases"

    dataset_id: Mapped[str] = mapped_column(
        ForeignKey("catalog_datasets.id", ondelete="CASCADE"), primary_key=True
    )
    principal_id: Mapped[str] = mapped_column(String(36), index=True)
    revision_id: Mapped[str] = mapped_column(String(36))
    lease_token: Mapped[str] = mapped_column(String(64), unique=True)
    expires_at: Mapped[str] = mapped_column(String(32), index=True)
    heartbeat_at: Mapped[str] = mapped_column(String(32))
    dataset: Mapped[CatalogDataset] = relationship(back_populates="lease")


class CatalogProcessingJob(Base):
    __tablename__ = "catalog_processing_jobs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    dataset_id: Mapped[str] = mapped_column(
        ForeignKey("catalog_datasets.id", ondelete="CASCADE"), index=True
    )
    input_revision_id: Mapped[str] = mapped_column(String(36))
    operation: Mapped[str] = mapped_column(String(64))
    parameters_json: Mapped[str] = mapped_column(Text, default="{}")
    output_revision_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    status: Mapped[str] = mapped_column(String(24), default="queued", index=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_by: Mapped[str] = mapped_column(String(36), index=True)
    created_at: Mapped[str] = mapped_column(String(32))
    completed_at: Mapped[str | None] = mapped_column(String(32), nullable=True)
    __table_args__ = (Index("ix_catalog_jobs_created", "created_at"),)

class CatalogUpload(Base):
    __tablename__ = "catalog_uploads"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    folder_id: Mapped[str] = mapped_column(
        ForeignKey("catalog_folders.id", ondelete="RESTRICT"), index=True
    )
    dataset_id: Mapped[str | None] = mapped_column(
        ForeignKey("catalog_datasets.id", ondelete="CASCADE"), nullable=True, index=True
    )
    source_revision_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    lease_token: Mapped[str | None] = mapped_column(String(64), nullable=True)
    principal_id: Mapped[str] = mapped_column(String(36), index=True)
    filename: Mapped[str] = mapped_column(String(255))
    content_type: Mapped[str] = mapped_column(String(255))
    size_bytes: Mapped[int] = mapped_column(BigInteger)
    s3_bucket: Mapped[str] = mapped_column(String(255))
    s3_key: Mapped[str] = mapped_column(String(2000), unique=True)
    status: Mapped[str] = mapped_column(String(24), default="issued", index=True)
    created_at: Mapped[str] = mapped_column(String(32))
