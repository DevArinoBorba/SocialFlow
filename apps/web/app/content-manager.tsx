"use client";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type {
  Brand,
  ContentBatch,
  ImportError,
  Post,
  PostStatus,
  SocialAccountDto,
  PublishPostResponse,
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

  // Estado do Modal de Publicação Manual na Meta
  const [publishingPost, setPublishingPost] = useState<Post | null>(null);
  const [activeAccounts, setActiveAccounts] = useState<SocialAccountDto[]>([]);
  const [selectedAccountIds, setSelectedAccountIds] = useState<string[]>([]);
  const [mediaAssets, setMediaAssets] = useState<
    Array<{
      id: string;
      name: string;
      mimeType: string | null;
      width: number | null;
      height: number | null;
    }>
  >([]);
  const [selectedMediaId, setSelectedMediaId] = useState<string>("");
  const [publishingBusy, setPublishingBusy] = useState(false);
  const [publishResult, setPublishResult] =
    useState<PublishPostResponse | null>(null);
  const [publishModalError, setPublishModalError] = useState("");
  const [hasConfirmedWarning, setHasConfirmedWarning] = useState(false);

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

  const handleOpenPublishModal = async (post: Post) => {
    if (!canApprove || post.status !== "APPROVED") return;
    setPublishingPost(post);
    setPublishResult(null);
    setPublishModalError("");
    setHasConfirmedWarning(false);
    setPublishingBusy(true);

    try {
      const [accounts, mediaResponse] = await Promise.all([
        request<SocialAccountDto[]>(
          `/api/organizations/${encodeURIComponent(org)}/clients/${encodeURIComponent(clientId)}/social-accounts`,
        ),
        request<{
          items: Array<{
            id: string;
            name: string;
            mimeType: string | null;
            width: number | null;
            height: number | null;
          }>;
        }>(
          `/api/organizations/${encodeURIComponent(org)}/clients/${encodeURIComponent(clientId)}/media`,
        ),
      ]);

      const active = accounts.filter((a) => a.status === "ACTIVE");
      setActiveAccounts(active);
      setSelectedAccountIds(active.map((a) => a.id));
      const assets = Array.isArray(mediaResponse?.items)
        ? mediaResponse.items
        : [];
      setMediaAssets(assets);
      if (assets.length > 0 && assets[0]) {
        setSelectedMediaId(assets[0].id);
      } else {
        setSelectedMediaId("");
      }
    } catch (err) {
      setPublishModalError((err as Error).message);
    } finally {
      setPublishingBusy(false);
    }
  };

  const handleClosePublishModal = () => {
    if (publishingBusy) return;
    setPublishingPost(null);
    setPublishResult(null);
    setPublishModalError("");
  };

  const handleToggleAccount = (id: string) => {
    setSelectedAccountIds((prev) =>
      prev.includes(id) ? prev.filter((accId) => accId !== id) : [...prev, id],
    );
  };

  const handleConfirmPublish = async () => {
    if (!canApprove) return;
    if (!publishingPost || publishingPost.status !== "APPROVED") return;
    if (selectedAccountIds.length === 0) {
      setPublishModalError(
        "Selecione ao menos uma conta social para publicação.",
      );
      return;
    }
    const hasInstagram = activeAccounts.some(
      (a) =>
        selectedAccountIds.includes(a.id) &&
        a.platform === "INSTAGRAM_BUSINESS",
    );
    if (hasInstagram && !selectedMediaId) {
      setPublishModalError(
        "Publicações no Instagram exigem a seleção de uma imagem.",
      );
      return;
    }

    setPublishingBusy(true);
    setPublishModalError("");

    try {
      const idempotencyKey =
        typeof crypto !== "undefined" && crypto.randomUUID
          ? crypto.randomUUID()
          : `pub_${Date.now()}_${Math.random().toString(36).slice(2)}`;

      const result = await request<PublishPostResponse>(
        `${postBase}/${encodeURIComponent(publishingPost.id)}/publish`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            socialAccountIds: selectedAccountIds,
            mediaAssetId: selectedMediaId || undefined,
            idempotencyKey,
          }),
        },
      );
      setPublishResult(result);
      refresh();
    } catch (err) {
      setPublishModalError((err as Error).message);
    } finally {
      setPublishingBusy(false);
    }
  };

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

                  {/* Aprovado -> Publicar Agora */}
                  {post.status === "APPROVED" && canApprove && (
                    <button
                      type="button"
                      className="publish-btn"
                      disabled={busy}
                      onClick={() => handleOpenPublishModal(post)}
                    >
                      Publicar agora…
                    </button>
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

      {/* Modal de Publicação Manual Controlada na Meta */}
      {publishingPost && (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="publish-modal-title"
        >
          <div className="publish-modal">
            <h3 id="publish-modal-title">Publicação Manual na Meta</h3>

            <p className="muted">
              Publicando post:{" "}
              <strong>{publishingPost.title || "Sem título"}</strong>
            </p>

            <blockquote className="post-preview-caption">
              {publishingPost.caption}
              {publishingPost.hashtags && (
                <div className="post-preview-hashtags">
                  {publishingPost.hashtags}
                </div>
              )}
            </blockquote>

            {publishModalError && (
              <p role="alert" className="error">
                {publishModalError}
              </p>
            )}

            {!publishResult ? (
              <>
                <div className="publish-modal-alert">
                  <strong>Atenção:</strong> Esta ação publicará o conteúdo
                  imediatamente nas redes da Meta selecionadas. Esta operação é
                  irreversível externamente.
                </div>

                {/* Seleção de Contas Sociais Ativas */}
                <div className="publish-accounts-group">
                  <label>Selecione as contas de destino:</label>
                  {activeAccounts.length === 0 ? (
                    <p className="muted">
                      Nenhuma conta social ativa encontrada para este cliente.
                      Conecte uma Página do Facebook ou Instagram antes de
                      publicar.
                    </p>
                  ) : (
                    activeAccounts.map((acc) => {
                      const isChecked = selectedAccountIds.includes(acc.id);
                      return (
                        <label
                          key={acc.id}
                          className="account-check-card"
                          htmlFor={`acc-check-${acc.id}`}
                        >
                          <input
                            id={`acc-check-${acc.id}`}
                            type="checkbox"
                            checked={isChecked}
                            disabled={publishingBusy}
                            onChange={() => handleToggleAccount(acc.id)}
                          />
                          <div>
                            <strong>{acc.name}</strong>{" "}
                            {acc.username && (
                              <span className="muted">(@{acc.username})</span>
                            )}
                          </div>
                          <span
                            className={`account-badge ${
                              acc.platform === "FACEBOOK_PAGE"
                                ? "facebook"
                                : "instagram"
                            }`}
                          >
                            {acc.platform === "FACEBOOK_PAGE"
                              ? "Facebook"
                              : "Instagram"}
                          </span>
                        </label>
                      );
                    })
                  )}
                </div>

                {/* Seleção de Mídia (se houver ou se obrigatório) */}
                <div className="publish-media-picker">
                  <label htmlFor="media-picker-select">
                    Imagem da publicação:{" "}
                    {activeAccounts.some(
                      (a) =>
                        selectedAccountIds.includes(a.id) &&
                        a.platform === "INSTAGRAM_BUSINESS",
                    ) && (
                      <span className="error-text">
                        *(Obrigatória para Instagram)
                      </span>
                    )}
                  </label>

                  {mediaAssets.length === 0 ? (
                    <p className="small muted">
                      Nenhuma imagem na biblioteca deste cliente. Faça o upload
                      de uma imagem na aba Biblioteca de Mídia para publicar no
                      Instagram.
                    </p>
                  ) : (
                    <>
                      <select
                        id="media-picker-select"
                        value={selectedMediaId}
                        disabled={publishingBusy}
                        onChange={(e) => setSelectedMediaId(e.target.value)}
                      >
                        <option value="">
                          Sem imagem (apenas texto no Facebook)
                        </option>
                        {mediaAssets.map((asset) => (
                          <option key={asset.id} value={asset.id}>
                            {asset.name} ({asset.width}x{asset.height})
                          </option>
                        ))}
                      </select>

                      <div className="media-thumbnail-grid">
                        {mediaAssets.slice(0, 6).map((asset) => (
                          <div
                            key={asset.id}
                            className={`media-thumbnail-item ${
                              selectedMediaId === asset.id ? "selected" : ""
                            }`}
                            onClick={() =>
                              !publishingBusy && setSelectedMediaId(asset.id)
                            }
                          >
                            <img
                              src={`/api/organizations/${encodeURIComponent(
                                org,
                              )}/clients/${encodeURIComponent(
                                clientId,
                              )}/media/${encodeURIComponent(asset.id)}/content`}
                              alt={asset.name}
                              className="media-thumbnail-img"
                            />
                            <small
                              className="muted"
                              style={{
                                display: "block",
                                fontSize: "0.75rem",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {asset.name}
                            </small>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </div>

                <div style={{ marginTop: "16px" }}>
                  <label
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "8px",
                      cursor: "pointer",
                      fontSize: "0.9rem",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={hasConfirmedWarning}
                      disabled={publishingBusy}
                      onChange={(e) => setHasConfirmedWarning(e.target.checked)}
                      style={{ width: "18px", height: "18px" }}
                    />
                    Estou ciente e autorizo a publicação imediata na Meta.
                  </label>
                </div>

                <div className="publish-modal-actions">
                  <button
                    type="button"
                    className="quiet"
                    disabled={publishingBusy}
                    onClick={handleClosePublishModal}
                  >
                    Cancelar
                  </button>
                  <button
                    type="button"
                    className="publish-btn"
                    disabled={
                      publishingBusy ||
                      !hasConfirmedWarning ||
                      selectedAccountIds.length === 0
                    }
                    onClick={handleConfirmPublish}
                  >
                    {publishingBusy
                      ? "Publicando na Meta…"
                      : "Confirmar e Publicar"}
                  </button>
                </div>
              </>
            ) : (
              /* Relatório e Resultado pós-publicação */
              <div className="publish-results-box">
                <h4>Resultado da Publicação</h4>
                {publishResult.success ? (
                  <p className="notice">
                    Publicação realizada com sucesso em todas as contas
                    selecionadas!
                  </p>
                ) : (
                  <p className="error">
                    Houve falhas em uma ou mais contas durante a publicação.
                    Verifique os detalhes abaixo:
                  </p>
                )}

                <div style={{ marginTop: "12px" }}>
                  {publishResult.attempts.map((att) => {
                    const acc = activeAccounts.find(
                      (a) => a.id === att.socialAccountId,
                    );
                    const isOk = att.status === "PUBLISHED";
                    return (
                      <div
                        key={att.id}
                        className={`publish-attempt-item ${
                          isOk ? "success" : "failed"
                        }`}
                      >
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                          }}
                        >
                          <strong>{acc?.name || att.platform}</strong>
                          <span
                            className={`badge ${
                              isOk ? "badge-completed" : "badge-failed"
                            }`}
                          >
                            {att.status}
                          </span>
                        </div>
                        {isOk && att.remotePermalink && (
                          <p style={{ margin: "6px 0 0", fontSize: "0.85rem" }}>
                            <a
                              href={att.remotePermalink}
                              target="_blank"
                              rel="noreferrer noopener"
                              style={{
                                color: "var(--accent)",
                                fontWeight: 600,
                              }}
                            >
                              Ver post publicado na Meta ↗
                            </a>
                          </p>
                        )}
                        {!isOk && att.errorMessage && (
                          <p
                            style={{
                              margin: "6px 0 0",
                              fontSize: "0.85rem",
                              color: "var(--error)",
                            }}
                          >
                            Motivo: {att.errorMessage}
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>

                <div className="publish-modal-actions">
                  <button
                    type="button"
                    className="publish-btn"
                    onClick={handleClosePublishModal}
                  >
                    Fechar
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
