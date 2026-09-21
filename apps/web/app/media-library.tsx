"use client";
import { useEffect, useState, type FormEvent } from "react";
import type { Brand } from "@socialflow/contracts";

type Asset = {
  id: string;
  name: string;
  description: string;
  brandId: string | null;
  width: number;
  height: number;
  byteSize: number;
};
async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok)
    throw new Error(
      data.message ?? "Não foi possível concluir. Tente novamente.",
    );
  return data as T;
}
export function MediaLibrary({
  org,
  clientId,
  brands,
  canWrite,
  canArchive,
  refreshKey,
}: {
  org: string;
  clientId: string;
  brands: Brand[];
  canWrite: boolean;
  canArchive: boolean;
  refreshKey?: number | string;
}) {
  const base = `/api/organizations/${encodeURIComponent(org)}/clients/${encodeURIComponent(clientId)}/media`;
  const [items, setItems] = useState<Asset[]>([]),
    [page, setPage] = useState(1),
    [filter, setFilter] = useState("");
  const [hasMore, setHasMore] = useState(false),
    [available, setAvailable] = useState(false),
    [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [revision, setRevision] = useState(0),
    [editing, setEditing] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setLoading(true);
    setItems([]);
    setError("");
    request<{ items: Asset[]; hasMore: boolean; available: boolean }>(
      `${base}?page=${page}&brandId=${encodeURIComponent(filter)}`,
    )
      .then((data) => {
        if (live) {
          setItems(data.items);
          setHasMore(data.hasMore);
          setAvailable(data.available);
        }
      })
      .catch((err) => {
        if (live) setError((err as Error).message);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [base, page, filter, revision, refreshKey]);
  const refresh = () => setRevision((v) => v + 1);
  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const file = data.get("image") as File;
    if (!file?.size || file.size > 10 * 1024 * 1024) {
      setError("Escolha uma imagem de até 10 MB.");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("Preparando envio…");
    try {
      const asset = await request<{ id: string }>(base, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: data.get("name"),
          description: data.get("description"),
          brandId: data.get("brandId") || null,
        }),
      });
      setNotice("Enviando e validando imagem…");
      await request(`${base}/${asset.id}/content`, {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: file,
      });
      form.reset();
      setPage(1);
      setNotice("Imagem adicionada à biblioteca.");
      refresh();
    } catch (err) {
      setError((err as Error).message);
      setNotice("");
    } finally {
      setBusy(false);
    }
  }
  async function edit(event: FormEvent<HTMLFormElement>, id: string) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      await request(`${base}/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: data.get("name"),
          description: data.get("description"),
          brandId: data.get("brandId") || null,
        }),
      });
      setEditing(null);
      setNotice("Imagem atualizada.");
      refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function archive(id: string) {
    setBusy(true);
    setError("");
    try {
      await request(`${base}/${id}`, { method: "DELETE" });
      setNotice("Imagem arquivada.");
      refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function fields(asset?: Asset) {
    return (
      <>
        <label>
          Nome da imagem
          <input
            name="name"
            required
            minLength={2}
            maxLength={120}
            defaultValue={asset?.name}
          />
        </label>
        <label>
          Sobre a imagem
          <textarea
            name="description"
            maxLength={2000}
            defaultValue={asset?.description}
          />
        </label>
        <label>
          Marca
          <select name="brandId" defaultValue={asset?.brandId ?? ""}>
            <option value="">Sem marca</option>
            {brands.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
      </>
    );
  }
  return (
    <section className="media-library" aria-labelledby="media-heading">
      <h2 id="media-heading">Biblioteca de imagens</h2>
      <p className="muted">Imagens deste cliente, organizadas por marca.</p>
      {error && (
        <p role="alert" className="error">
          {error}{" "}
          <button className="quiet" onClick={refresh}>
            Tentar novamente
          </button>
        </p>
      )}
      {notice && (
        <p role="status" className="notice">
          {notice}
        </p>
      )}
      {!loading && !available && !error && (
        <p>O armazenamento de imagens ainda não está configurado.</p>
      )}
      {canWrite && available && (
        <details className="media-upload">
          <summary>Adicionar imagem</summary>
          <form className="create-form" onSubmit={upload} aria-busy={busy}>
            <div className="fields">
              {fields()}
              <label>
                Arquivo
                <input
                  name="image"
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  required
                />
                <small>
                  JPEG, PNG ou WebP estático. Até 10 MB e 25 megapixels.
                </small>
              </label>
            </div>
            <button disabled={busy}>
              {busy ? "Enviando…" : "Enviar imagem"}
            </button>
          </form>
        </details>
      )}
      <label className="media-filter">
        Filtrar por marca
        <select
          value={filter}
          onChange={(event) => {
            setFilter(event.target.value);
            setPage(1);
          }}
        >
          <option value="">Todas as marcas</option>
          {brands.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      </label>
      {loading ? (
        <p role="status">Carregando imagens…</p>
      ) : !items.length && !error ? (
        <p className="empty">
          Nenhuma imagem encontrada.{" "}
          {canWrite && available ? "Use Adicionar imagem para começar." : ""}
        </p>
      ) : (
        <div className="media-grid">
          {items.map((asset) => (
            <article
              key={asset.id}
              className="media-item"
              data-asset-id={asset.id}
            >
              {/* Authenticated same-origin images must bypass public image optimizers. */}
              <img
                src={`${base}/${asset.id}/content`}
                alt={asset.description || asset.name}
                width={asset.width}
                height={asset.height}
                loading="lazy"
              />
              <h3>{asset.name}</h3>
              {editing === asset.id ? (
                <form onSubmit={(e) => edit(e, asset.id)}>
                  {fields(asset)}
                  <div className="form-actions">
                    <button disabled={busy}>Salvar imagem</button>
                    <button
                      type="button"
                      className="quiet"
                      onClick={() => setEditing(null)}
                    >
                      Cancelar
                    </button>
                  </div>
                </form>
              ) : (
                <>
                  <p>{asset.description}</p>
                  <small>
                    {asset.width} × {asset.height} ·{" "}
                    {(asset.byteSize / 1024).toFixed(0)} KB
                  </small>
                  <div className="form-actions">
                    {canWrite && (
                      <button
                        className="quiet"
                        disabled={busy}
                        onClick={() => setEditing(asset.id)}
                      >
                        Editar imagem
                      </button>
                    )}
                    {canArchive && (
                      <button
                        className="quiet"
                        disabled={busy}
                        onClick={() => void archive(asset.id)}
                      >
                        Arquivar imagem
                      </button>
                    )}
                  </div>
                </>
              )}
            </article>
          ))}
        </div>
      )}
      {(page > 1 || hasMore) && (
        <nav aria-label="Páginas da biblioteca" className="form-actions">
          <button
            className="quiet"
            disabled={loading || page === 1}
            onClick={() => setPage((p) => p - 1)}
          >
            Anterior
          </button>
          <span>Página {page}</span>
          <button
            className="quiet"
            disabled={loading || !hasMore}
            onClick={() => setPage((p) => p + 1)}
          >
            Próxima
          </button>
        </nav>
      )}
    </section>
  );
}
