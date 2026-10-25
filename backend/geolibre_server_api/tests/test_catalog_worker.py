from __future__ import annotations

import pytest

from geolibre_server_api.processing_worker import validate_raster_job


def test_validate_clip_job_requires_ordered_numeric_bbox():
    validate_raster_job("raster.clip", {"bbox": [0, 0, 10, 20]})

    with pytest.raises(ValueError, match="positive width"):
        validate_raster_job("raster.clip", {"bbox": [10, 0, 0, 20]})

    with pytest.raises(ValueError, match="numbers"):
        validate_raster_job("raster.clip", {"bbox": [0, 0, "east", 20]})


def test_validate_reproject_job_requires_destination_crs():
    validate_raster_job("raster.reproject", {"dst_crs": "EPSG:3857"})

    with pytest.raises(ValueError, match="dst_crs"):
        validate_raster_job("raster.reproject", {})


def test_validate_rejects_unknown_operation():
    with pytest.raises(ValueError, match="unsupported raster operation"):
        validate_raster_job("raster.buffer", {})
