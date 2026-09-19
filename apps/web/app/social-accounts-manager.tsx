"use client";

import { useEffect, useState, useCallback } from "react";
import type {
  SocialAccountDto,
  DiscoveredSocialAssetDto,
  MetaAuthorizeResponse,
  ConnectSocialAccountsResponse,
  MetaDiscoveryResponse,
  SocialPlatform,
} from "@socialflow/contracts";

async function apiRequest<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    if (response.status === 401) {
      throw new Error("Sessão expirada. Entre novamente.");
    }
    if (response.status === 403) {
      throw new Error("Permissão insuficiente para esta operação.");
    }
    if (response.status === 404) {
      throw new Error(
        data.message ?? "Recurso não encontrado ou sessão expirada.",
      );
    }
    if (response.status === 503) {
      throw new Error(
        data.message ?? "Serviço indisponível no momento. Tente novamente.",
      );
    }
    throw new Error(
      data.message ?? "Não foi possível concluir a operação. Tente novamente.",
    );
  }

  return data as T;
}

export function SocialAccountsManager({
  org,
  clientId,
  canWrite,
  initialDiscoveryId,
  initialMetaError,
  onClearMetaParams,
}: {
  org: string;
  clientId: string;
  canWrite: boolean;
  initialDiscoveryId?: string | null;
  initialMetaError?: string | null;
  onClearMetaParams?: () => void;
}) {
  const base = `/api/organizations/${encodeURIComponent(org)}/clients/${encodeURIComponent(clientId)}`;

  const [accounts, setAccounts] = useState<SocialAccountDto[]>([]);
  const [loadingAccounts, setLoadingAccounts] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  // Discovery state
  const [discoveryId, setDiscoveryId] = useState<string | null>(
    initialDiscoveryId ?? null,
  );
  const [discoveryAssets, setDiscoveryAssets] = useState<
    DiscoveredSocialAssetDto[]
  >([]);
  const [loadingDiscovery, setLoadingDiscovery] = useState(false);
  const [selectedAssets, setSelectedAssets] = useState<
    Array<{ platformAccountId: string; platform: SocialPlatform }>
  >([]);

  // Disconnect confirmation modal
  const [accountToDisconnect, setAccountToDisconnect] =
    useState<SocialAccountDto | null>(null);

  // Load connected accounts
  const loadAccounts = useCallback(async () => {
    setLoadingAccounts(true);
    try {
      const data = await apiRequest<SocialAccountDto[]>(
        `${base}/social-accounts`,
      );
      setAccounts(data);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoadingAccounts(false);
    }
  }, [base]);

  useEffect(() => {
    void loadAccounts();
  }, [loadAccounts]);

  // Handle incoming meta_error from query parameters
  useEffect(() => {
    if (initialMetaError) {
      if (initialMetaError === "consent_cancelled") {
        setError("A conexão com a Meta foi cancelada pelo usuário.");
      } else if (
        initialMetaError === "state_expired" ||
        initialMetaError === "expired"
      ) {
        setError(
          "A sessão de autorização expirou ou já foi utilizada. Tente novamente.",
        );
      } else if (initialMetaError === "forbidden") {
        setError(
          "Permissão insuficiente ou escopo inválido para esta operação.",
        );
      } else if (initialMetaError === "not_configured") {
        setError("A integração com a Meta não está configurada no servidor.");
      } else {
        setError(
          "Não foi possível concluir a autorização com a Meta. Tente novamente.",
        );
      }
      onClearMetaParams?.();
    }
  }, [initialMetaError, onClearMetaParams]);

  // Handle incoming discoveryId
  useEffect(() => {
    if (!discoveryId) return;

    let active = true;
    setLoadingDiscovery(true);
    setError("");
    setSelectedAssets([]); // Regra estrita: sem seleção automática

    apiRequest<MetaDiscoveryResponse>(
      `${base}/integrations/meta/discovery/${encodeURIComponent(discoveryId)}`,
    )
      .then((data) => {
        if (!active) return;
        setDiscoveryAssets(data.assets);
        if (data.assets.length === 0) {
          setNotice(
            "Nenhuma página do Facebook ou conta profissional do Instagram vinculada foi encontrada na conta autorizada.",
          );
        }
      })
      .catch((err) => {
        if (!active) return;
        const msg = (err as Error).message;
        if (
          msg.includes("expirada") ||
          msg.includes("404") ||
          msg.includes("não encontrada")
        ) {
          setError(
            "A sessão de descoberta expirou. Inicie o processo de conexão novamente.",
          );
        } else {
          setError(msg);
        }
        setDiscoveryId(null);
      })
      .finally(() => {
        if (active) {
          setLoadingDiscovery(false);
          onClearMetaParams?.();
        }
      });

    return () => {
      active = false;
    };
  }, [base, discoveryId, onClearMetaParams]);

  // Initiate OAuth flow
  async function handleConnectMeta() {
    if (!canWrite) {
      setError(
        "Apenas administradores e editores podem conectar contas sociais.",
      );
      return;
    }

    setBusy(true);
    setError("");
    setNotice("Iniciando conexão com a Meta…");

    try {
      const data = await apiRequest<MetaAuthorizeResponse>(
        `${base}/integrations/meta/authorize`,
      );
      if (data.authorizationUrl) {
        window.location.href = data.authorizationUrl;
      } else {
        throw new Error("URL de autorização não retornada pelo servidor.");
      }
    } catch (err) {
      setError((err as Error).message);
      setNotice("");
      setBusy(false);
    }
  }

  // Toggle selection for an asset (explicit user choice only)
  function toggleAssetSelection(
    asset: DiscoveredSocialAssetDto,
    checked: boolean,
  ) {
    if (checked) {
      setSelectedAssets((prev) => [
        ...prev,
        {
          platformAccountId: asset.platformAccountId,
          platform: asset.platform,
        },
      ]);
    } else {
      setSelectedAssets((prev) =>
        prev.filter(
          (a) =>
            !(
              a.platformAccountId === asset.platformAccountId &&
              a.platform === asset.platform
            ),
        ),
      );
    }
  }

  // Select or deselect all
  function toggleSelectAll(checked: boolean) {
    if (checked) {
      setSelectedAssets(
        discoveryAssets.map((a) => ({
          platformAccountId: a.platformAccountId,
          platform: a.platform,
        })),
      );
    } else {
      setSelectedAssets([]);
    }
  }

  // Confirm connection of selected assets
  async function handleConfirmConnect() {
    if (!discoveryId || selectedAssets.length === 0) return;

    setBusy(true);
    setError("");
    setNotice("Conectando contas selecionadas…");

    try {
      const result = await apiRequest<ConnectSocialAccountsResponse>(
        `${base}/social-accounts/connect`,
        {
          method: "POST",
          body: JSON.stringify({
            discoveryId,
            selectedAssets,
          }),
        },
      );

      setDiscoveryId(null);
      setDiscoveryAssets([]);
      setSelectedAssets([]);
      setNotice(
        `${result.connectedAccounts.length} conta(s) conectada(s) com sucesso!`,
      );
      await loadAccounts();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // Cancel discovery selection
  function handleCancelDiscovery() {
    setDiscoveryId(null);
    setDiscoveryAssets([]);
    setSelectedAssets([]);
    setError("");
  }

  // Disconnect confirmation
  async function handleConfirmDisconnect() {
    if (!accountToDisconnect) return;

    setBusy(true);
    setError("");
    setNotice(`Desconectando ${accountToDisconnect.name}…`);

    try {
      await apiRequest(
        `${base}/social-accounts/${encodeURIComponent(accountToDisconnect.id)}`,
        {
          method: "DELETE",
        },
      );

      setNotice(`Conta ${accountToDisconnect.name} desconectada com sucesso.`);
      setAccountToDisconnect(null);
      await loadAccounts();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const activeAccounts = accounts.filter(
    (acc) => acc.status === "ACTIVE" || acc.status === "EXPIRED",
  );

  return (
    <section
      className="social-accounts-section"
      aria-labelledby="social-heading"
    >
      <div className="social-header">
        <div>
          <h2 id="social-heading">Contas Sociais</h2>
          <p className="muted">
            Gerencie as conexões de páginas do Facebook e perfis profissionais
            do Instagram para publicação e agendamento.
          </p>
        </div>

        {canWrite && !discoveryId && activeAccounts.length > 0 && (
          <button
            type="button"
            className="btn-connect-meta"
            onClick={handleConnectMeta}
            disabled={busy || loadingAccounts}
          >
            {busy ? "Conectando…" : "Conectar Meta"}
          </button>
        )}
      </div>

      {error && (
        <div role="alert" className="error-box">
          <p>{error}</p>
          <button
            type="button"
            className="quiet error-dismiss"
            onClick={() => setError("")}
          >
            Fechar
          </button>
        </div>
      )}

      {notice && (
        <p role="status" className="notice">
          {notice}
        </p>
      )}

      {/* Discovery Selection Modal/Panel */}
      {discoveryId && (
        <div className="discovery-panel" aria-labelledby="discovery-title">
          <div className="discovery-header">
            <div>
              <h3 id="discovery-title">Selecionar Contas para Conexão</h3>
              <p className="muted">
                Escolha abaixo quais páginas do Facebook e perfis do Instagram
                você deseja vincular a este cliente. Nenhuma conta é conectada
                automaticamente.
              </p>
            </div>
            {discoveryAssets.length > 0 && (
              <div className="discovery-select-all">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={
                      selectedAssets.length === discoveryAssets.length &&
                      discoveryAssets.length > 0
                    }
                    onChange={(e) => toggleSelectAll(e.target.checked)}
                    disabled={busy}
                  />
                  <span>Selecionar todas ({discoveryAssets.length})</span>
                </label>
              </div>
            )}
          </div>

          {loadingDiscovery ? (
            <p role="status" className="empty">
              Consultando ativos disponíveis na Meta…
            </p>
          ) : discoveryAssets.length === 0 ? (
            <div className="empty">
              <p>
                Nenhuma página do Facebook ou perfil profissional do Instagram
                foi encontrado com as permissões concedidas.
              </p>
              <button
                type="button"
                className="quiet"
                onClick={handleCancelDiscovery}
              >
                Voltar
              </button>
            </div>
          ) : (
            <div className="discovery-assets-list">
              {discoveryAssets.map((asset) => {
                const isSelected = selectedAssets.some(
                  (a) =>
                    a.platformAccountId === asset.platformAccountId &&
                    a.platform === asset.platform,
                );
                const inputId = `asset-${asset.platform}-${asset.platformAccountId}`;

                return (
                  <article
                    key={`${asset.platform}-${asset.platformAccountId}`}
                    className={`discovery-asset-card ${isSelected ? "selected" : ""}`}
                  >
                    <label htmlFor={inputId} className="asset-checkbox-wrapper">
                      <input
                        type="checkbox"
                        id={inputId}
                        checked={isSelected}
                        onChange={(e) =>
                          toggleAssetSelection(asset, e.target.checked)
                        }
                        disabled={busy}
                      />
                      <div className="asset-info">
                        <div className="asset-title-row">
                          <span
                            className={`platform-badge badge-${asset.platform.toLowerCase()}`}
                          >
                            {asset.platform === "FACEBOOK_PAGE"
                              ? "Facebook Page"
                              : "Instagram"}
                          </span>
                          <strong className="asset-name">{asset.name}</strong>
                        </div>
                        {asset.username && (
                          <span className="asset-username muted">
                            @{asset.username}
                          </span>
                        )}
                      </div>
                    </label>
                  </article>
                );
              })}
            </div>
          )}

          <div className="discovery-actions">
            <button
              type="button"
              className="btn-confirm-connect"
              onClick={handleConfirmConnect}
              disabled={busy || selectedAssets.length === 0 || loadingDiscovery}
            >
              {busy
                ? "Conectando…"
                : `Conectar ${selectedAssets.length} conta(s) selecionada(s)`}
            </button>
            <button
              type="button"
              className="quiet"
              onClick={handleCancelDiscovery}
              disabled={busy}
            >
              Cancelar
            </button>
          </div>
        </div>
      )}

      {/* Connected Accounts List */}
      {loadingAccounts ? (
        <p role="status" className="empty">
          Carregando contas sociais…
        </p>
      ) : activeAccounts.length > 0 ? (
        <div className="social-accounts-grid">
          {activeAccounts.map((account) => (
            <article key={account.id} className="social-account-card">
              <div className="account-card-header">
                <span
                  className={`platform-badge badge-${account.platform.toLowerCase()}`}
                >
                  {account.platform === "FACEBOOK_PAGE"
                    ? "Facebook Page"
                    : "Instagram"}
                </span>
                <span
                  className={`status-pill status-${account.status.toLowerCase()}`}
                >
                  {account.status === "ACTIVE" ? "Ativo" : "Expirado"}
                </span>
              </div>

              <div className="account-card-body">
                <h3 className="account-name">{account.name}</h3>
                {account.username && (
                  <p className="account-username muted">@{account.username}</p>
                )}
              </div>

              {canWrite && (
                <div className="account-card-actions">
                  <button
                    type="button"
                    className="quiet danger-btn"
                    onClick={() => setAccountToDisconnect(account)}
                    disabled={busy}
                  >
                    Desconectar
                  </button>
                </div>
              )}
            </article>
          ))}
        </div>
      ) : (
        !discoveryId && (
          <div className="empty">
            <h3>Nenhuma conta social conectada</h3>
            <p>
              {canWrite
                ? "Conecte sua página do Facebook ou conta profissional do Instagram para iniciar publicações e agendamentos."
                : "Nenhuma conta social conectada para este cliente."}
            </p>
            {canWrite && (
              <button
                type="button"
                className="btn-connect-meta"
                onClick={handleConnectMeta}
                disabled={busy}
              >
                Conectar Meta
              </button>
            )}
          </div>
        )
      )}

      {/* Disconnect Confirmation Dialog */}
      {accountToDisconnect && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="dialog-title"
          className="modal-overlay"
        >
          <div className="modal-box">
            <h3 id="dialog-title">Confirmar desconexão</h3>
            <p>
              Tem certeza de que deseja desconectar a conta{" "}
              <strong>{accountToDisconnect.name}</strong>?
            </p>
            <p className="muted">
              Esta ação removerá as credenciais de publicação do SocialFlow para
              esta conta. Publicações futuras agendadas precisarão de uma nova
              conexão para serem transmitidas.
            </p>
            <div className="modal-actions">
              <button
                type="button"
                className="danger-btn"
                onClick={handleConfirmDisconnect}
                disabled={busy}
              >
                {busy ? "Desconectando…" : "Confirmar desconexão"}
              </button>
              <button
                type="button"
                className="quiet"
                onClick={() => setAccountToDisconnect(null)}
                disabled={busy}
              >
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
