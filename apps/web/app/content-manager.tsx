"use client";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type {
  Brand,
  ContentBatch,
  ImportError,
  Post,
  PostStatus,
} from "@socialflow/contracts";

type Props = {
  org: string;
  clientId: string;
  brands: Brand[];
  canWrite: boolean;
  canApprove: boolean;
  canSubmitReview: boolean;
};

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) {
    throw new Error(
      data.message ?? "Não foi possível concluir a operação. Tente novamente.",
    );
  }
  return data as T;
}

export function ContentManager({
  org,
  clientId,
  brands,
  canWrite,
  canApprove,
  canSubmitReview,
}: Props) {
  const batchBase = `/api/organizations/${encodeURIComponent(org)}/clients/${encodeURIComponent(clientId)}/batches`;
  const postBase = `/api/organizations/${encodeURIComponent(org)}/clients/${encodeURIComponent(clientId)}/posts`;

  const [posts, setPosts] = useState<Post[]>([]);
  const [batches, setBatches] = useState<ContentBatch[]>([]);
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [brandFilter, setBrandFilter] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [revision, setRevision] = useState(0);

  // Formulários e painéis
  const [showCreatePost, setShowCreatePost] = useState(false);
  const [showImportCsv, setShowImportCsv] = useState(false);
  const [showBatches, setShowBatches] = useState(false);

  // Estado de criação de post
  const [postForm, setPostForm] = useState({
    title: "",
    caption: "",
    suggestedDate: "",
    brandId: "",
    hashtags: "",
    callToAction: "",
    firstComment: "",
  });

  // Estado de importação de CSV
  const [batchName, setBatchName] = useState("Lote CSV");
  const [importErrors, setImportErrors] = useState<ImportError[]>([]);
  const [importSummary, setImportSummary] = useState<string | null>(null);

  // Estado de rejeição de post
  const [rejectingPostId, setRejectingPostId] = useState<string | null>(null);
  const [rejectionReason, setRejectionReason] = useState("");

  const refresh = useCallback(() => setRevision((v) => v + 1), []);

  // Carregar posts
  useEffect(() => {
    let live = true;
    setLoading(true);
    setError("");

    const params = new URLSearchParams();
    if (statusFilter) params.set("status", statusFilter);

    const url = params.toString() ? `${postBase}?${params}` : postBase;

    request<Post[]>(url)
      .then((data) => {
        if (live) setPosts(data);
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
  }, [postBase, statusFilter, revision]);

  // Carregar histórico de lotes
  useEffect(() => {
    if (!showBatches) return;
    let live = true;
    request<ContentBatch[]>(batchBase)
      .then((data) => {
        if (live) setBatches(data);
      })
      .catch((err) => {
        if (live) setError((err as Error).message);
      });
    return () => {
      live = false;
    };
  }, [batchBase, showBatches, revision]);

  // Criar post avulso
  async function handleCreatePost(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!postForm.caption.trim()) {
      setError("O texto/legenda da publicação é obrigatório.");
      return;
    }

    setBusy(true);
    setError("");
    setNotice("Criando publicação…");

    try {
      await request(postBase, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: postForm.title.trim() || undefined,
          caption: postForm.caption.trim(),
          suggestedDate: postForm.suggestedDate
            ? new Date(postForm.suggestedDate).toISOString()
            : undefined,
          brandId: postForm.brandId || undefined,
          hashtags: postForm.hashtags.trim() || undefined,
          callToAction: postForm.callToAction.trim() || undefined,
          firstComment: postForm.firstComment.trim() || undefined,
        }),
      });

      setNotice("Publicação criada com sucesso como rascunho.");
      setShowCreatePost(false);
      setPostForm({
        title: "",
        caption: "",
        suggestedDate: "",
        brandId: "",
        hashtags: "",
        callToAction: "",
        firstComment: "",
      });
      refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // Importar CSV
  async function handleImportCsv(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    const file = formData.get("csvFile") as File;

    if (!file || !file.size) {
      setError("Selecione um arquivo CSV para importar.");
      return;
    }

    if (file.size > 2 * 1024 * 1024) {
      setError("O arquivo CSV excede o limite máximo permitido de 2 MiB.");
      return;
    }

    setBusy(true);
    setError("");
    setImportErrors([]);
    setImportSummary(null);
    setNotice("Criando lote e enviando arquivo CSV…");

    try {
      // 1. Criar registro do lote
      const batch = await request<{ id: string }>(batchBase, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: batchName.trim() || "Lote CSV",
          sourceType: "CSV",
        }),
      });

      // 2. Enviar arquivo CSV binário para processamento
      setNotice("Processando e validando linhas do CSV…");
      const importResult = await request<{
        batchId: string;
        totalRows: number;
        validRows: number;
        invalidRows: number;
        errors: ImportError[];
      }>(`${batchBase}/${encodeURIComponent(batch.id)}/import`, {
        method: "POST",
        headers: { "Content-Type": "text/csv" },
        body: file,
      });

      setImportSummary(
        `Importação concluída: ${importResult.validRows} post(s) importado(s) com sucesso. ${importResult.invalidRows} erro(s) em ${importResult.totalRows} linha(s) analisada(s).`,
      );
      setImportErrors(importResult.errors || []);
      setNotice("Lote processado com sucesso.");
      form.reset();
      refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // Transição de status de post
  async function handleStatusTransition(
    postId: string,
    targetStatus: PostStatus,
    reason?: string,
  ) {
    setBusy(true);
    setError("");
    setNotice("Atualizando status da publicação…");

    try {
      await request(`${postBase}/${encodeURIComponent(postId)}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: targetStatus,
          rejectionReason: reason ? reason.trim() : undefined,
        }),
      });

      setNotice(
        targetStatus === "APPROVED"
          ? "Publicação aprovada com sucesso."
          : targetStatus === "REJECTED"
            ? "Publicação rejeitada."
            : targetStatus === "IN_REVIEW"
              ? "Publicação enviada para revisão."
              : "Status atualizado.",
      );
      setRejectingPostId(null);
      setRejectionReason("");
      refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const filteredPosts = posts.filter((p) => {
    if (brandFilter && p.brandId !== brandFilter) return false;
    return true;
  });

  const getStatusLabel = (status: PostStatus) => {
    switch (status) {
      case "DRAFT":
        return "Rascunho";
      case "IN_REVIEW":
        return "Em revisão";
      case "APPROVED":
        return "Aprovado";
      case "REJECTED":
        return "Rejeitado";
      default:
        return status;
    }
  };

  const getStatusClass = (status: PostStatus) => {
    switch (status) {
      case "DRAFT":
        return "badge-draft";
      case "IN_REVIEW":
        return "badge-review";
      case "APPROVED":
        return "badge-approved";
      case "REJECTED":
        return "badge-rejected";
      default:
        return "";
    }
  };

  return (
    <section className="content-manager" aria-labelledby="content-heading">
      <div className="content-header">
        <div>
          <h2 id="content-heading">Conteúdo e Publicações</h2>
          <p className="muted">
            Planejamento, lotes de conteúdo em CSV e fluxo de aprovação de
            posts.
          </p>
        </div>
        {canWrite && (
          <div className="content-actions">
            <button
              type="button"
              onClick={() => {
                setShowCreatePost(!showCreatePost);
                setShowImportCsv(false);
                setError("");
              }}
              aria-expanded={showCreatePost}
            >
              {showCreatePost ? "Fechar formulário" : "Novo post"}
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setShowImportCsv(!showImportCsv);
                setShowCreatePost(false);
                setError("");
              }}
              aria-expanded={showImportCsv}
            >
              {showImportCsv ? "Fechar importador" : "Importar CSV"}
            </button>
          </div>
        )}
      </div>

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

      {/* Formulário de Criação de Post */}
      {showCreatePost && canWrite && (
        <form
          className="create-form post-form"
          onSubmit={handleCreatePost}
          aria-label="Formulário de nova publicação"
        >
          <h3>Nova Publicação</h3>
          <div className="fields">
            <div>
              <label htmlFor="post-title">Título (opcional)</label>
              <input
                id="post-title"
                type="text"
                maxLength={120}
                placeholder="Ex: Lançamento Coleção Outono"
                value={postForm.title}
                onChange={(e) =>
                  setPostForm((prev) => ({ ...prev, title: e.target.value }))
                }
              />
              <small>Até 120 caracteres.</small>
            </div>
            <div>
              <label htmlFor="post-brand">Marca associada (opcional)</label>
              <select
                id="post-brand"
                value={postForm.brandId}
                onChange={(e) =>
                  setPostForm((prev) => ({ ...prev, brandId: e.target.value }))
                }
              >
                <option value="">Nenhuma marca associada</option>
                {brands.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label htmlFor="post-caption">
              Texto da publicação (legenda) *
            </label>
            <textarea
              id="post-caption"
              required
              maxLength={5000}
              placeholder="Digite o texto principal que acompanhará o post..."
              value={postForm.caption}
              onChange={(e) =>
                setPostForm((prev) => ({ ...prev, caption: e.target.value }))
              }
            />
            <small>Obrigatório. Até 5.000 caracteres.</small>
          </div>

          <div className="fields">
            <div>
              <label htmlFor="post-suggested-date">
                Data sugerida (opcional)
              </label>
              <input
                id="post-suggested-date"
                type="datetime-local"
                value={postForm.suggestedDate}
                onChange={(e) =>
                  setPostForm((prev) => ({
                    ...prev,
                    suggestedDate: e.target.value,
                  }))
                }
              />
            </div>
            <div>
              <label htmlFor="post-hashtags">Hashtags (opcional)</label>
              <input
                id="post-hashtags"
                type="text"
                maxLength={1000}
                placeholder="#moda #outono #novidades"
                value={postForm.hashtags}
                onChange={(e) =>
                  setPostForm((prev) => ({ ...prev, hashtags: e.target.value }))
                }
              />
            </div>
          </div>

          <div className="fields">
            <div>
              <label htmlFor="post-cta">
                Chamada para Ação / CTA (opcional)
              </label>
              <input
                id="post-cta"
                type="text"
                maxLength={500}
                placeholder="Clique no link da bio para conferir!"
                value={postForm.callToAction}
                onChange={(e) =>
                  setPostForm((prev) => ({
                    ...prev,
                    callToAction: e.target.value,
                  }))
                }
              />
            </div>
            <div>
              <label htmlFor="post-comment">
                Primeiro comentário (opcional)
              </label>
              <input
                id="post-comment"
                type="text"
                maxLength={2200}
                placeholder="Links extras, créditos ou tags adicionais"
                value={postForm.firstComment}
                onChange={(e) =>
                  setPostForm((prev) => ({
                    ...prev,
                    firstComment: e.target.value,
                  }))
                }
              />
            </div>
          </div>

          <div className="form-actions">
            <button disabled={busy} type="submit">
              {busy ? "Salvando…" : "Salvar rascunho"}
            </button>
            <button
              type="button"
              className="quiet"
              onClick={() => setShowCreatePost(false)}
              disabled={busy}
            >
              Cancelar
            </button>
          </div>
        </form>
      )}

      {/* Formulário de Importação de Lote CSV */}
      {showImportCsv && canWrite && (
        <form
          className="create-form csv-import-form"
          onSubmit={handleImportCsv}
          aria-label="Importação de lote CSV"
        >
          <h3>Importar Lote de Conteúdo via CSV</h3>
          <p className="muted">
            Envie um arquivo CSV com a coluna obrigatória: <code>caption</code>{" "}
            (texto). Colunas opcionais suportadas: <code>title</code>,{" "}
            <code>hashtags</code>, <code>callToAction</code>,{" "}
            <code>firstComment</code>, <code>suggestedDate</code> (formato ISO
            8601). Máximo de 500 linhas e 2 MiB.
          </p>

          <div className="fields">
            <div>
              <label htmlFor="batch-name">Nome do lote</label>
              <input
                id="batch-name"
                type="text"
                required
                maxLength={120}
                value={batchName}
                onChange={(e) => setBatchName(e.target.value)}
              />
            </div>
            <div>
              <label htmlFor="csv-file">Arquivo CSV (.csv)</label>
              <input
                id="csv-file"
                name="csvFile"
                type="file"
                accept=".csv,text/csv,text/plain"
                required
              />
            </div>
          </div>

          <div className="form-actions">
            <button disabled={busy} type="submit">
              {busy ? "Processando lote…" : "Iniciar importação"}
            </button>
            <button
              type="button"
              className="quiet"
              onClick={() => setShowImportCsv(false)}
              disabled={busy}
            >
              Fechar
            </button>
          </div>

          {importSummary && (
            <div className="import-summary" role="status">
              <p>
                <strong>{importSummary}</strong>
              </p>
            </div>
          )}

          {importErrors.length > 0 && (
            <div
              className="import-errors-table"
              role="region"
              aria-label="Erros de importação"
            >
              <h4>
                Erros identificados no arquivo CSV ({importErrors.length})
              </h4>
              <p className="small muted">
                As linhas com erro abaixo foram ignoradas, enquanto todas as
                linhas válidas foram importadas como rascunho com sucesso.
              </p>
              <table>
                <thead>
                  <tr>
                    <th>Linha</th>
                    <th>Coluna</th>
                    <th>Erro</th>
                    <th>Valor Lido</th>
                  </tr>
                </thead>
                <tbody>
                  {importErrors.map((err, i) => (
                    <tr key={i}>
                      <td>{err.row}</td>
                      <td>
                        <code>{err.column}</code>
                      </td>
                      <td>{err.message}</td>
                      <td>
                        <code>{err.rawValue || "—"}</code>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </form>
      )}

      {/* Barra de Filtros e Histórico */}
      <div className="content-filters">
        <div className="filter-group">
          <label htmlFor="filter-post-status" className="filter-label">
            Filtrar status:
          </label>
          <select
            id="filter-post-status"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            <option value="">Todos os status</option>
            <option value="DRAFT">Rascunhos</option>
            <option value="IN_REVIEW">Em revisão</option>
            <option value="APPROVED">Aprovados</option>
            <option value="REJECTED">Rejeitados</option>
          </select>
        </div>

        {brands.length > 0 && (
          <div className="filter-group">
            <label htmlFor="filter-post-brand" className="filter-label">
              Filtrar marca:
            </label>
            <select
              id="filter-post-brand"
              value={brandFilter}
              onChange={(e) => setBrandFilter(e.target.value)}
            >
              <option value="">Todas as marcas</option>
              {brands.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="filter-group batches-toggle">
          <button
            type="button"
            className="quiet link-button"
            onClick={() => setShowBatches(!showBatches)}
          >
            {showBatches ? "Ocultar lotes CSV" : "Ver histórico de lotes CSV"}
          </button>
        </div>
      </div>

      {/* Histórico de Lotes CSV */}
      {showBatches && (
        <div
          className="batches-history"
          role="region"
          aria-label="Histórico de lotes CSV"
        >
          <h3>Histórico de Lotes Importados</h3>
          {batches.length === 0 ? (
            <p className="muted">Nenhum lote importado até o momento.</p>
          ) : (
            <div className="batch-grid">
              {batches.map((batch) => (
                <article key={batch.id} className="batch-card">
                  <div className="batch-header">
                    <h4>{batch.name}</h4>
                    <span
                      className={`badge badge-${batch.status.toLowerCase()}`}
                    >
                      {batch.status}
                    </span>
                  </div>
                  <p className="small muted">
                    Criado em:{" "}
                    {new Date(batch.createdAt).toLocaleString("pt-BR")}
                  </p>
                  <div className="batch-metrics">
                    <span>
                      Total: <strong>{batch.totalRows}</strong>
                    </span>
                    <span className="success-text">
                      Válidos: <strong>{batch.validRows}</strong>
                    </span>
                    <span className={batch.invalidRows > 0 ? "error-text" : ""}>
                      Inválidos: <strong>{batch.invalidRows}</strong>
                    </span>
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Listagem de Posts */}
      {loading ? (
        <p role="status">Carregando publicações…</p>
      ) : filteredPosts.length > 0 ? (
        <div className="post-grid">
          {filteredPosts.map((post) => {
            const postBrand = brands.find((b) => b.id === post.brandId);
            const isRejecting = rejectingPostId === post.id;

            return (
              <article
                key={post.id}
                className={`post-card ${getStatusClass(post.status)}`}
              >
                <div className="post-card-header">
                  <span className={`badge ${getStatusClass(post.status)}`}>
                    {getStatusLabel(post.status)}
                  </span>
                  {postBrand && (
                    <span className="brand-tag">{postBrand.name}</span>
                  )}
                </div>

                <h3>{post.title || "Publicação sem título"}</h3>
                <p className="post-caption">{post.caption}</p>

                {post.hashtags && (
                  <p className="post-meta">
                    <strong>Tags:</strong> {post.hashtags}
                  </p>
                )}

                {post.callToAction && (
                  <p className="post-meta">
                    <strong>CTA:</strong> {post.callToAction}
                  </p>
                )}

                {post.suggestedDate && (
                  <p className="post-meta date-meta">
                    <strong>Data sugerida:</strong>{" "}
                    {new Date(post.suggestedDate).toLocaleString("pt-BR")}
                  </p>
                )}

                {/* Mensagem de rejeição, se houver */}
                {post.status === "REJECTED" && post.rejectionReason && (
                  <div className="rejection-box" role="alert">
                    <strong>Motivo da rejeição:</strong> {post.rejectionReason}
                  </div>
                )}

                {/* Workflow de Ações de Status */}
                <div className="post-workflow-actions">
                  {/* Rascunho ou Rejeitado -> Enviar para revisão */}
                  {(post.status === "DRAFT" || post.status === "REJECTED") &&
                    canSubmitReview && (
                      <button
                        type="button"
                        className="secondary"
                        disabled={busy}
                        onClick={() =>
                          handleStatusTransition(post.id, "IN_REVIEW")
                        }
                      >
                        Enviar para revisão
                      </button>
                    )}

                  {/* Em Revisão -> Aprovar ou Rejeitar */}
                  {post.status === "IN_REVIEW" && canApprove && (
                    <>
                      <button
                        type="button"
                        className="success-btn"
                        disabled={busy}
                        onClick={() =>
                          handleStatusTransition(post.id, "APPROVED")
                        }
                      >
                        Aprovar publicação
                      </button>

                      {!isRejecting ? (
                        <button
                          type="button"
                          className="danger-btn"
                          disabled={busy}
                          onClick={() => {
                            setRejectingPostId(post.id);
                            setRejectionReason("");
                          }}
                        >
                          Rejeitar…
                        </button>
                      ) : null}
                    </>
                  )}
                </div>

                {/* Diálogo inline para informar justificativa de rejeição */}
                {isRejecting && (
                  <div className="reject-dialog">
                    <label htmlFor={`reject-reason-${post.id}`}>
                      Justificativa da rejeição: *
                    </label>
                    <textarea
                      id={`reject-reason-${post.id}`}
                      required
                      placeholder="Descreva o motivo da rejeição ou as alterações necessárias..."
                      value={rejectionReason}
                      onChange={(e) => setRejectionReason(e.target.value)}
                    />
                    <div className="form-actions">
                      <button
                        type="button"
                        className="danger-btn"
                        disabled={busy || !rejectionReason.trim()}
                        onClick={() =>
                          handleStatusTransition(
                            post.id,
                            "REJECTED",
                            rejectionReason,
                          )
                        }
                      >
                        Confirmar rejeição
                      </button>
                      <button
                        type="button"
                        className="quiet"
                        disabled={busy}
                        onClick={() => {
                          setRejectingPostId(null);
                          setRejectionReason("");
                        }}
                      >
                        Cancelar
                      </button>
                    </div>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      ) : (
        <section className="empty">
          <h3>Nenhuma publicação encontrada</h3>
          <p className="muted">
            {canWrite
              ? "Crie uma nova publicação ou importe um lote CSV para começar."
              : "Nenhuma publicação cadastrada neste filtro para este cliente."}
          </p>
        </section>
      )}
    </section>
  );
}
