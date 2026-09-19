"use client";
import { MediaLibrary } from "./media-library";
import { ContentManager } from "./content-manager";
import { SocialAccountsManager } from "./social-accounts-manager";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  isAdmin,
  type Brand,
  type Client,
  type CurrentUser,
} from "@socialflow/contracts";

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...options?.headers },
  });
  const data = await res.json();
  if (!res.ok)
    throw new Error(
      res.status === 401
        ? "Sessão expirada. Entre novamente."
        : (data.message ?? "Não foi possível concluir. Tente novamente."),
    );
  return data as T;
}

export default function Home() {
  const [me, setMe] = useState<CurrentUser | null>(null);
  const [org, setOrg] = useState("");
  const [clients, setClients] = useState<Client[]>([]);
  const [selectedClientId, setSelectedClientId] = useState<string | null>(null);
  const [brands, setBrands] = useState<Brand[]>([]);
  const [loading, setLoading] = useState(true);
  const [listing, setListing] = useState(false);
  const [listingBrands, setListingBrands] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [creating, setCreating] = useState(false);
  const [creatingBrand, setCreatingBrand] = useState(false);
  const [editingBrandId, setEditingBrandId] = useState<string | null>(null);
  const [discoveryIdParam, setDiscoveryIdParam] = useState<string | null>(null);
  const [metaErrorParam, setMetaErrorParam] = useState<string | null>(null);
  const [brandForm, setBrandForm] = useState({
    name: "",
    description: "",
    targetAudience: "",
    toneOfVoice: "",
  });
  const [editBrandForm, setEditBrandForm] = useState({
    name: "",
    description: "",
    targetAudience: "",
    toneOfVoice: "",
  });

  const clearMetaParams = useCallback(() => {
    setDiscoveryIdParam(null);
    setMetaErrorParam(null);
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.delete("discoveryId");
      url.searchParams.delete("meta_error");
      const search = url.searchParams.toString();
      window.history.replaceState(
        {},
        "",
        url.pathname + (search ? `?${search}` : ""),
      );
    }
  }, []);

  const refreshSession = useCallback(async () => {
    try {
      const current = await api<CurrentUser>("/me");
      setMe(current);
      setOrg((prevOrg) => {
        if (prevOrg) return prevOrg;
        if (typeof window !== "undefined") {
          const params = new URLSearchParams(window.location.search);
          const orgParam = params.get("org");
          if (
            orgParam &&
            current.memberships.some((m) => m.organizationId === orgParam)
          ) {
            return orgParam;
          }
        }
        return current.memberships[0]?.organizationId ?? "";
      });
    } catch {
      setMe(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const dId = params.get("discoveryId");
    const mErr = params.get("meta_error");
    if (dId) setDiscoveryIdParam(dId);
    if (mErr) setMetaErrorParam(mErr);
  }, []);

  useEffect(() => {
    void refreshSession();
  }, [refreshSession]);

  useEffect(() => {
    if (!org || !me) return;
    let active = true;
    setListing(true);
    setClients([]);
    setSelectedClientId(null);
    setError("");
    setCreating(false);
    void api<Client[]>(`/organizations/${org}/clients`)
      .then((data) => {
        if (active) {
          setClients(data);
          if (typeof window !== "undefined") {
            const params = new URLSearchParams(window.location.search);
            const clientParam = params.get("client");
            if (clientParam && data.some((c) => c.id === clientParam)) {
              setSelectedClientId(clientParam);
            }
          }
        }
      })
      .catch((e: Error) => {
        if (active) {
          setError(e.message);
          if (e.message.startsWith("Sessão")) setMe(null);
        }
      })
      .finally(() => {
        if (active) setListing(false);
      });
    return () => {
      active = false;
    };
  }, [org, me]);

  useEffect(() => {
    if (!org || !me || !selectedClientId) {
      setBrands([]);
      setListingBrands(false);
      return;
    }
    let active = true;
    setListingBrands(true);
    setCreatingBrand(false);
    setEditingBrandId(null);
    setError("");
    void api<Brand[]>(
      `/organizations/${org}/clients/${selectedClientId}/brands`,
    )
      .then((data) => {
        if (active) setBrands(data);
      })
      .catch((e: Error) => {
        if (active) {
          setError(e.message);
          if (e.message.startsWith("Sessão")) setMe(null);
        }
      })
      .finally(() => {
        if (active) setListingBrands(false);
      });
    return () => {
      active = false;
    };
  }, [org, me, selectedClientId]);

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      await api("/auth/sign-in/email", {
        method: "POST",
        body: JSON.stringify({
          email: form.get("email"),
          password: form.get("password"),
        }),
      });
      await refreshSession();
    } catch {
      setError(
        "Não foi possível entrar. Confira e-mail e senha ou aguarde um minuto antes de tentar novamente.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const client = await api<Client>(`/organizations/${org}/clients`, {
        method: "POST",
        body: JSON.stringify({
          name: data.get("name"),
          slug: data.get("slug"),
        }),
      });
      setClients((previous) =>
        [...previous, client].sort((a, b) => a.name.localeCompare(b.name)),
      );
      form.reset();
      setCreating(false);
      setNotice(`Cliente ${client.name} criado.`);
    } catch (e) {
      const message = (e as Error).message;
      setError(message);
      if (message.startsWith("Sessão")) setMe(null);
    } finally {
      setBusy(false);
    }
  }

  async function createBrand(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedClientId) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const created = await api<Brand>(
        `/organizations/${org}/clients/${selectedClientId}/brands`,
        {
          method: "POST",
          body: JSON.stringify(brandForm),
        },
      );
      setBrands((previous) =>
        [...previous, created].sort((a, b) => a.name.localeCompare(b.name)),
      );
      setBrandForm({
        name: "",
        description: "",
        targetAudience: "",
        toneOfVoice: "",
      });
      setCreatingBrand(false);
      setNotice(`Marca ${created.name} criada com sucesso.`);
    } catch (e) {
      const message = (e as Error).message;
      setError(message);
      if (message.startsWith("Sessão")) setMe(null);
    } finally {
      setBusy(false);
    }
  }

  function startEditingBrand(brand: Brand) {
    setEditingBrandId(brand.id);
    setEditBrandForm({
      name: brand.name,
      description: brand.description ?? "",
      targetAudience: brand.targetAudience ?? "",
      toneOfVoice: brand.toneOfVoice ?? "",
    });
    setError("");
    setNotice("");
  }

  async function updateBrand(
    event: FormEvent<HTMLFormElement>,
    brandId: string,
  ) {
    event.preventDefault();
    if (!selectedClientId) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const updated = await api<Brand>(
        `/organizations/${org}/clients/${selectedClientId}/brands/${brandId}`,
        {
          method: "PATCH",
          body: JSON.stringify(editBrandForm),
        },
      );
      setBrands((previous) =>
        previous
          .map((b) => (b.id === brandId ? updated : b))
          .sort((a, b) => a.name.localeCompare(b.name)),
      );
      setEditingBrandId(null);
      setNotice(`Marca ${updated.name} atualizada com sucesso.`);
    } catch (e) {
      const message = (e as Error).message;
      setError(message);
      if (message.startsWith("Sessão")) setMe(null);
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    setBusy(true);
    setError("");
    try {
      await api("/auth/sign-out", { method: "POST", body: "{}" });
      setMe(null);
      setClients([]);
      setSelectedClientId(null);
      setBrands([]);
      setNotice("");
    } catch {
      setError("Não foi possível sair. Tente novamente.");
    } finally {
      setBusy(false);
    }
  }

  if (loading)
    return (
      <main className="loading" role="status">
        Abrindo sua área de trabalho…
      </main>
    );

  if (!me)
    return (
      <main className="login-shell">
        <section className="intro">
          <a className="wordmark" href="/">
            SocialFlow<span aria-hidden="true">.</span>
          </a>
          <div>
            <h1>
              Um lugar para
              <br />
              cuidar de cada cliente.
            </h1>
            <p>Acesse a área de trabalho da sua equipe.</p>
          </div>
          <p className="intro-footer">Organização começa com clareza.</p>
        </section>
        <section className="login-panel">
          <form onSubmit={login}>
            <h2>Entre na sua conta</h2>
            <p className="muted">Use o acesso fornecido pela sua agência.</p>
            <label htmlFor="email">E-mail</label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="username"
              required
              maxLength={254}
            />
            <label htmlFor="password">Senha</label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              maxLength={128}
            />
            {error && (
              <p role="alert" className="error">
                {error}
              </p>
            )}
            <button disabled={busy} type="submit">
              {busy ? "Entrando…" : "Entrar"}
            </button>
            <p className="help">
              Precisa de acesso? Fale com o administrador da sua organização.
            </p>
          </form>
        </section>
      </main>
    );

  const organizations = [
    ...new Map(
      me.memberships.map((m) => [m.organizationId, m.organization.name]),
    ).entries(),
  ];

  const canCreateClient = me.memberships.some(
    (m) => m.organizationId === org && m.clientId === null && isAdmin(m.role),
  );

  const currentClient = clients.find((c) => c.id === selectedClientId);

  const canWriteBrands = me.memberships.some(
    (m) =>
      m.organizationId === org &&
      ((m.clientId === null && isAdmin(m.role)) ||
        (m.clientId === selectedClientId && m.role === "EDITOR")),
  );

  const canApprove = me.memberships.some(
    (m) =>
      m.organizationId === org &&
      ((m.clientId === null && isAdmin(m.role)) ||
        (m.clientId === selectedClientId &&
          (m.role === "APPROVER" || m.role === "OWNER" || m.role === "ADMIN"))),
  );

  const canManageSocial = me.memberships.some(
    (m) =>
      m.organizationId === org &&
      ((m.clientId === null && (isAdmin(m.role) || m.role === "EDITOR")) ||
        (m.clientId === selectedClientId &&
          (m.role === "OWNER" || m.role === "ADMIN" || m.role === "EDITOR"))),
  );

  return (
    <div className="workspace">
      <a className="skip" href="#content">
        Ir para o conteúdo principal
      </a>
      <header>
        <a href="/" className="wordmark">
          SocialFlow<span aria-hidden="true">.</span>
        </a>
        <div className="account">
          <span>{me.user.name}</span>
          <button className="quiet" onClick={logout} disabled={busy}>
            Sair
          </button>
        </div>
      </header>

      <main id="content">
        <div className="organization">
          <label htmlFor="organization">Organização</label>
          <select
            id="organization"
            value={org}
            onChange={(e) => {
              setOrg(e.target.value);
              setSelectedClientId(null);
              setError("");
              setNotice("");
            }}
          >
            {organizations.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </div>

        {selectedClientId ? (
          /* Visão Detalhada do Cliente e suas Marcas */
          <div>
            <div className="breadcrumb">
              <button
                className="quiet"
                onClick={() => {
                  setSelectedClientId(null);
                  setCreatingBrand(false);
                  setEditingBrandId(null);
                  setError("");
                  setNotice("");
                }}
              >
                ← Voltar para todos os clientes
              </button>
            </div>

            <div className="page-heading">
              <div>
                <h1>{currentClient?.name ?? "Cliente"}</h1>
                <p className="muted">
                  Identificador: {currentClient?.slug ?? selectedClientId}
                </p>
              </div>
              {canWriteBrands && (
                <button
                  onClick={() => {
                    setCreatingBrand(!creatingBrand);
                    setError("");
                  }}
                  aria-expanded={creatingBrand}
                  aria-controls="create-brand"
                >
                  {creatingBrand ? "Fechar formulário" : "Nova marca"}
                </button>
              )}
            </div>

            {error && (
              <p role="alert" className="error">
                {error}{" "}
                <button
                  className="quiet"
                  onClick={() => {
                    void refreshSession();
                  }}
                >
                  Tentar novamente
                </button>
              </p>
            )}

            {notice && (
              <p role="status" className="notice">
                {notice}
              </p>
            )}

            {creatingBrand && canWriteBrands && (
              <form
                id="create-brand"
                className="create-form"
                onSubmit={createBrand}
              >
                <h2>Nova marca</h2>
                <div className="fields">
                  <div>
                    <label htmlFor="brand-name">Nome da marca *</label>
                    <input
                      id="brand-name"
                      name="name"
                      required
                      minLength={2}
                      maxLength={120}
                      value={brandForm.name}
                      onChange={(e) =>
                        setBrandForm((prev) => ({
                          ...prev,
                          name: e.target.value,
                        }))
                      }
                      placeholder="Ex.: Café Origens"
                    />
                    <small>Obrigatório. Entre 2 e 120 caracteres.</small>
                  </div>
                  <div>
                    <label htmlFor="brand-description">Descrição</label>
                    <textarea
                      id="brand-description"
                      name="description"
                      maxLength={2000}
                      value={brandForm.description}
                      onChange={(e) =>
                        setBrandForm((prev) => ({
                          ...prev,
                          description: e.target.value,
                        }))
                      }
                      placeholder="Resumo do posicionamento da marca…"
                    />
                    <small>Opcional. Até 2000 caracteres.</small>
                  </div>
                  <div>
                    <label htmlFor="brand-targetAudience">Público-alvo</label>
                    <textarea
                      id="brand-targetAudience"
                      name="targetAudience"
                      maxLength={1000}
                      value={brandForm.targetAudience}
                      onChange={(e) =>
                        setBrandForm((prev) => ({
                          ...prev,
                          targetAudience: e.target.value,
                        }))
                      }
                      placeholder="Perfil do consumidor ou audiência-chave…"
                    />
                    <small>Opcional. Até 1000 caracteres.</small>
                  </div>
                  <div>
                    <label htmlFor="brand-toneOfVoice">Tom de voz</label>
                    <textarea
                      id="brand-toneOfVoice"
                      name="toneOfVoice"
                      maxLength={1000}
                      value={brandForm.toneOfVoice}
                      onChange={(e) =>
                        setBrandForm((prev) => ({
                          ...prev,
                          toneOfVoice: e.target.value,
                        }))
                      }
                      placeholder="Ex.: Informal, acolhedor, inspirador…"
                    />
                    <small>Opcional. Até 1000 caracteres.</small>
                  </div>
                </div>
                <div className="form-actions">
                  <button disabled={busy} type="submit">
                    {busy ? "Criando…" : "Criar marca"}
                  </button>
                  <button
                    type="button"
                    className="quiet"
                    onClick={() => setCreatingBrand(false)}
                    disabled={busy}
                  >
                    Cancelar
                  </button>
                </div>
              </form>
            )}

            {listingBrands ? (
              <p role="status" className="empty">
                Carregando marcas…
              </p>
            ) : brands.length ? (
              <section aria-label="Marcas do cliente" className="brand-list">
                {brands.map((brand) =>
                  editingBrandId === brand.id ? (
                    <form
                      key={brand.id}
                      className="create-form"
                      onSubmit={(e) => updateBrand(e, brand.id)}
                    >
                      <h2>Editar marca: {brand.name}</h2>
                      <div className="fields">
                        <div>
                          <label htmlFor={`edit-name-${brand.id}`}>
                            Nome da marca *
                          </label>
                          <input
                            id={`edit-name-${brand.id}`}
                            name="name"
                            required
                            minLength={2}
                            maxLength={120}
                            value={editBrandForm.name}
                            onChange={(e) =>
                              setEditBrandForm((prev) => ({
                                ...prev,
                                name: e.target.value,
                              }))
                            }
                          />
                          <small>Obrigatório. Entre 2 e 120 caracteres.</small>
                        </div>
                        <div>
                          <label htmlFor={`edit-description-${brand.id}`}>
                            Descrição
                          </label>
                          <textarea
                            id={`edit-description-${brand.id}`}
                            name="description"
                            maxLength={2000}
                            value={editBrandForm.description}
                            onChange={(e) =>
                              setEditBrandForm((prev) => ({
                                ...prev,
                                description: e.target.value,
                              }))
                            }
                          />
                          <small>Opcional. Até 2000 caracteres.</small>
                        </div>
                        <div>
                          <label htmlFor={`edit-targetAudience-${brand.id}`}>
                            Público-alvo
                          </label>
                          <textarea
                            id={`edit-targetAudience-${brand.id}`}
                            name="targetAudience"
                            maxLength={1000}
                            value={editBrandForm.targetAudience}
                            onChange={(e) =>
                              setEditBrandForm((prev) => ({
                                ...prev,
                                targetAudience: e.target.value,
                              }))
                            }
                          />
                          <small>Opcional. Até 1000 caracteres.</small>
                        </div>
                        <div>
                          <label htmlFor={`edit-toneOfVoice-${brand.id}`}>
                            Tom de voz
                          </label>
                          <textarea
                            id={`edit-toneOfVoice-${brand.id}`}
                            name="toneOfVoice"
                            maxLength={1000}
                            value={editBrandForm.toneOfVoice}
                            onChange={(e) =>
                              setEditBrandForm((prev) => ({
                                ...prev,
                                toneOfVoice: e.target.value,
                              }))
                            }
                          />
                          <small>Opcional. Até 1000 caracteres.</small>
                        </div>
                      </div>
                      <div className="form-actions">
                        <button disabled={busy} type="submit">
                          {busy ? "Salvando…" : "Salvar alterações"}
                        </button>
                        <button
                          type="button"
                          className="quiet"
                          onClick={() => setEditingBrandId(null)}
                          disabled={busy}
                        >
                          Cancelar
                        </button>
                      </div>
                    </form>
                  ) : (
                    <article key={brand.id} className="brand-card">
                      <div className="brand-header">
                        <h3>{brand.name}</h3>
                        {canWriteBrands && (
                          <button
                            className="quiet"
                            onClick={() => startEditingBrand(brand)}
                          >
                            Editar
                          </button>
                        )}
                      </div>
                      <p className="brand-description">
                        {brand.description || "Sem descrição informada."}
                      </p>
                      <div className="brand-grid">
                        <div className="brand-item">
                          <strong>Público-alvo</strong>
                          <p>{brand.targetAudience || "Não definido"}</p>
                        </div>
                        <div className="brand-item">
                          <strong>Tom de voz</strong>
                          <p>{brand.toneOfVoice || "Não definido"}</p>
                        </div>
                      </div>
                    </article>
                  ),
                )}
              </section>
            ) : (
              !error && (
                <section className="empty">
                  <h2>Nenhuma marca por aqui ainda</h2>
                  <p>
                    {canWriteBrands
                      ? "Crie a primeira marca deste cliente para começar."
                      : "Nenhuma marca cadastrada para este cliente."}
                  </p>
                </section>
              )
            )}
            <SocialAccountsManager
              key={`social-${org}/${selectedClientId}`}
              org={org}
              clientId={selectedClientId}
              canWrite={canManageSocial}
              initialDiscoveryId={discoveryIdParam}
              initialMetaError={metaErrorParam}
              onClearMetaParams={clearMetaParams}
            />
            <MediaLibrary
              key={`${org}/${selectedClientId}`}
              org={org}
              clientId={selectedClientId}
              brands={brands}
              canWrite={canWriteBrands}
              canArchive={canCreateClient}
            />
            <ContentManager
              key={`content-${org}/${selectedClientId}`}
              org={org}
              clientId={selectedClientId}
              brands={brands}
              canWrite={canWriteBrands}
              canApprove={canApprove}
              canSubmitReview={canWriteBrands}
            />
          </div>
        ) : (
          /* Visão da Lista de Clientes */
          <div>
            <div className="page-heading">
              <div>
                <h1>Clientes</h1>
                <p className="muted">
                  Os espaços de trabalho aos quais você tem acesso.
                </p>
              </div>
              {canCreateClient && (
                <button
                  onClick={() => {
                    setCreating(!creating);
                    setError("");
                  }}
                  aria-expanded={creating}
                  aria-controls="create-client"
                >
                  {creating ? "Fechar formulário" : "Novo cliente"}
                </button>
              )}
            </div>

            {error && (
              <p role="alert" className="error">
                {error}{" "}
                <button
                  className="quiet"
                  onClick={() => {
                    void refreshSession();
                  }}
                >
                  Tentar novamente
                </button>
              </p>
            )}

            {notice && (
              <p role="status" className="notice">
                {notice}
              </p>
            )}

            {creating && canCreateClient && (
              <form
                id="create-client"
                className="create-form"
                onSubmit={create}
              >
                <h2>Novo cliente</h2>
                <div className="fields">
                  <div>
                    <label htmlFor="name">Nome do cliente</label>
                    <input
                      id="name"
                      name="name"
                      required
                      minLength={2}
                      maxLength={120}
                    />
                  </div>
                  <div>
                    <label htmlFor="slug">Identificador</label>
                    <input
                      id="slug"
                      name="slug"
                      required
                      minLength={2}
                      maxLength={80}
                      pattern="[a-z0-9]+(-[a-z0-9]+)*"
                      aria-describedby="slug-help"
                    />
                    <small id="slug-help">
                      Letras minúsculas, números e hífens. Ex.: cafe-central
                    </small>
                  </div>
                </div>
                <button disabled={busy}>
                  {busy ? "Criando…" : "Criar cliente"}
                </button>
              </form>
            )}

            {listing ? (
              <p role="status" className="empty">
                Carregando clientes…
              </p>
            ) : clients.length ? (
              <section
                aria-label="Clientes autorizados"
                className="client-list"
              >
                <div className="list-heading">
                  <span>Cliente</span>
                  <span>Ação</span>
                </div>
                {clients.map((client) => (
                  <article key={client.id}>
                    <div>
                      <h2>{client.name}</h2>
                      <p>{client.slug}</p>
                    </div>
                    <div className="client-actions">
                      <button
                        className="quiet"
                        onClick={() => {
                          setSelectedClientId(client.id);
                          setError("");
                          setNotice("");
                        }}
                      >
                        Abrir cliente
                      </button>
                      <span className="status">Ativo</span>
                    </div>
                  </article>
                ))}
              </section>
            ) : (
              !error && (
                <section className="empty">
                  <h2>
                    {org
                      ? "Nenhum cliente por aqui ainda"
                      : "Seu acesso está sendo preparado"}
                  </h2>
                  <p>
                    {canCreateClient
                      ? "Crie o primeiro cliente desta organização para começar."
                      : "O administrador pode vincular clientes ao seu acesso."}
                  </p>
                </section>
              )
            )}
          </div>
        )}

        <footer>SocialFlow · Área de trabalho da equipe</footer>
      </main>
    </div>
  );
}
