"use client";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { isAdmin, type Client, type CurrentUser } from "@socialflow/contracts";

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
  const [loading, setLoading] = useState(true);
  const [listing, setListing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [creating, setCreating] = useState(false);
  const refreshSession = useCallback(async () => {
    try {
      const current = await api<CurrentUser>("/me");
      setMe(current);
      setOrg(current.memberships[0]?.organizationId ?? "");
    } catch {
      setMe(null);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refreshSession();
  }, [refreshSession]);
  useEffect(() => {
    if (!org || !me) return;
    let active = true;
    setListing(true);
    setClients([]);
    setError("");
    setCreating(false);
    void api<Client[]>(`/organizations/${org}/clients`)
      .then((data) => {
        if (active) setClients(data);
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
  async function logout() {
    setBusy(true);
    setError("");
    try {
      await api("/auth/sign-out", { method: "POST", body: "{}" });
      setMe(null);
      setClients([]);
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
  const canCreate = me.memberships.some(
    (m) => m.organizationId === org && m.clientId === null && isAdmin(m.role),
  );
  return (
    <div className="workspace">
      <a className="skip" href="#content">
        Ir para clientes
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
            onChange={(e) => setOrg(e.target.value)}
          >
            {organizations.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </div>
        <div className="page-heading">
          <div>
            <h1>Clientes</h1>
            <p className="muted">
              Os espaços de trabalho aos quais você tem acesso.
            </p>
          </div>
          {canCreate && (
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
        {creating && canCreate && (
          <form id="create-client" className="create-form" onSubmit={create}>
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
          <section aria-label="Clientes autorizados" className="client-list">
            <div className="list-heading">
              <span>Cliente</span>
              <span>Situação</span>
            </div>
            {clients.map((client) => (
              <article key={client.id}>
                <div>
                  <h2>{client.name}</h2>
                  <p>{client.slug}</p>
                </div>
                <span className="status">Ativo</span>
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
                {canCreate
                  ? "Crie o primeiro cliente desta organização para começar."
                  : "O administrador pode vincular clientes ao seu acesso."}
              </p>
            </section>
          )
        )}
        <footer>SocialFlow · Área de trabalho da equipe</footer>
      </main>
    </div>
  );
}
