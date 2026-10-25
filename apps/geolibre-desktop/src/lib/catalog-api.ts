/** Typed client for the managed private-data catalog API.
 *
 * The deployment keeps this same-origin so the ALB/Entra session cookie is sent
 * automatically. The client never accepts arbitrary S3 keys for discovery or
 * edits; callers operate on catalog and revision IDs.
 */

export interface CatalogFolder {
  id: string;
  parent_id: string | null;
  display_name: string;
  logical_path: string;
  storage_prefix: string;
}

export interface CatalogRevision {
  id: string;
  s3_bucket: string;
  s3_key: string;
  s3_version_id: string | null;
  etag: string | null;
  size_bytes: number | null;
  source_revision_id: string | null;
  created_by: string;
  created_at: string;
  status: string;
}

export interface CatalogDataset {
  id: string;
  folder_id: string;
  display_name: string;
  format: string;
  description: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  current_revision_id: string | null;
}

export interface CatalogDatasetDetail extends CatalogDataset {
  revisions: CatalogRevision[];
}

export interface CatalogPage {
  items: CatalogDataset[];
  limit: number;
  offset: number;
  has_more: boolean;
}

export interface CatalogReadAccess {
  url: string;
  expires_at: string;
}

export interface CatalogLease {
  dataset_id: string;
  revision_id: string;
  lease_token: string;
  expires_at: string;
}

export interface CatalogUpload {
  id: string;
  key: string;
  content_type: string;
  size_bytes: number;
  url: string;
  fields: Record<string, string>;
  expires_at: string;
}

export interface CatalogUploadComplete {
  dataset: CatalogDatasetDetail;
}

export interface CatalogJob {
  id: string;
  dataset_id: string;
  input_revision_id: string;
  operation: string;
  parameters: Record<string, unknown>;
  output_revision_id: string | null;
  status: string;
  error: string | null;
  created_at: string;
  completed_at: string | null;
}

export class CatalogApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "CatalogApiError";
    this.status = status;
  }
}

export interface CatalogApiOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export function createCatalogApi(options: CatalogApiOptions = {}) {
  const baseUrl = (options.baseUrl ?? "/api/catalog").replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      ...init,
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
    });
    if (!response.ok) {
      let message = `Catalog request failed (${response.status}).`;
      try {
        const body = (await response.json()) as { error?: string };
        if (body.error) message = body.error;
      } catch {
        // Preserve the stable status-based message for non-JSON failures.
      }
      throw new CatalogApiError(response.status, message);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  return {
    listFolders(parentId?: string): Promise<CatalogFolder[]> {
      const query = parentId ? `?parent_id=${encodeURIComponent(parentId)}` : "";
      return request(`/folders${query}`);
    },

    listDatasets(params: {
      query?: string;
      folderId?: string;
      format?: string;
      limit?: number;
      offset?: number;
    } = {}): Promise<CatalogPage> {
      const query = new URLSearchParams();
      if (params.query) query.set("q", params.query);
      if (params.folderId) query.set("folder_id", params.folderId);
      if (params.format) query.set("format", params.format);
      if (params.limit !== undefined) query.set("limit", String(params.limit));
      if (params.offset !== undefined) query.set("offset", String(params.offset));
      const suffix = query.size > 0 ? `?${query.toString()}` : "";
      return request(`/datasets${suffix}`);
    },

    getDataset(datasetId: string): Promise<CatalogDatasetDetail> {
      return request(`/datasets/${encodeURIComponent(datasetId)}`);
    },

    getReadUrl(datasetId: string): Promise<CatalogReadAccess> {
      return request(`/datasets/${encodeURIComponent(datasetId)}/read-url`);
    },

    acquireEditLease(datasetId: string): Promise<CatalogLease> {
      return request(`/datasets/${encodeURIComponent(datasetId)}/edit-lease`, {
        method: "POST",
      });
    },

    releaseEditLease(datasetId: string): Promise<void> {
      return request(`/datasets/${encodeURIComponent(datasetId)}/edit-lease`, {
        method: "DELETE",
      });
    },

    createUpload(input: {
      folderId: string;
      filename: string;
      contentType: string;
      sizeBytes: number;
      format: string;
      datasetId?: string;
      leaseToken?: string;
    }): Promise<CatalogUpload> {
      return request("/uploads", {
        method: "POST",
        body: JSON.stringify({
          folder_id: input.folderId,
          filename: input.filename,
          content_type: input.contentType,
          size_bytes: input.sizeBytes,
          format: input.format,
          ...(input.datasetId ? { dataset_id: input.datasetId } : {}),
          ...(input.leaseToken ? { lease_token: input.leaseToken } : {}),
        }),
      });
    },

    async uploadFile(
      input: {
        folderId: string;
        file: File;
        format: string;
        datasetId?: string;
        leaseToken?: string;
      },
      onProgress?: (fraction: number) => void,
    ): Promise<CatalogDatasetDetail> {
      const upload = await this.createUpload({
        folderId: input.folderId,
        filename: input.file.name,
        contentType: input.file.type || "application/octet-stream",
        sizeBytes: input.file.size,
        format: input.format,
        datasetId: input.datasetId,
        leaseToken: input.leaseToken,
      });
      const body = new FormData();
      for (const [name, value] of Object.entries(upload.fields)) body.append(name, value);
      body.append("file", input.file);
      const response = await fetch(upload.url, { method: "POST", body });
      if (!response.ok) throw new CatalogApiError(response.status, "S3 upload failed.");
      onProgress?.(1);
      const completed = await request<CatalogUploadComplete>(
        `/uploads/${encodeURIComponent(upload.id)}/complete`,
        { method: "POST" },
      );
      return completed.dataset;
    },

    createRasterJob(datasetId: string, operation: string, parameters: Record<string, unknown> = {}): Promise<CatalogJob> {
      return request("/jobs", {
        method: "POST",
        body: JSON.stringify({ dataset_id: datasetId, operation, parameters }),
      });
    },

    getJob(jobId: string): Promise<CatalogJob> {
      return request(`/jobs/${encodeURIComponent(jobId)}`);
    },
  };
}
