import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Política de Privacidade | SocialFlow",
  description:
    "Política de Privacidade e Proteção de Dados da plataforma SocialFlow.",
};

export default function PrivacyPage() {
  return (
    <div className="public-doc-shell">
      <header className="public-doc-header">
        <div className="public-doc-header-inner">
          <a href="/" className="wordmark" aria-label="SocialFlow Início">
            SocialFlow<span aria-hidden="true">.</span>
          </a>
          <nav aria-label="Navegação institucional" className="public-doc-nav">
            <a href="/terms" className="public-doc-nav-link">
              Termos de Uso
            </a>
            <a href="/" className="public-doc-nav-link btn-login-link">
              Entrar
            </a>
          </nav>
        </div>
      </header>

      <main className="public-doc-main">
        <article className="public-doc-card">
          <header className="doc-article-header">
            <span className="doc-badge">Conformidade e Transparência</span>
            <h1>Política de Privacidade</h1>
            <p className="doc-meta muted">
              Última atualização: 19 de setembro de 2026 · Versão 1.0
            </p>
          </header>

          <section className="doc-section">
            <h2>1. Identificação do Responsável e Contato</h2>
            <p>
              A presente Política de Privacidade regula o tratamento de dados
              pessoais realizado pela plataforma <strong>SocialFlow</strong>,
              uma solução de gestão de fluxo editorial e conexão de canais
              sociais para agências e equipes de marketing.
            </p>
            <p>
              Para quaisquer dúvidas, solicitações ou exercício de direitos de
              privacidade (LGPD), entre em contato diretamente pelo canal
              oficial:
            </p>
            <div className="contact-box">
              <p>
                <strong>Responsável pelo SocialFlow:</strong> Arino Borba
              </p>
              <p>
                <strong>E-mail de Contato:</strong>{" "}
                <a href="mailto:arinoborba@gmail.com" className="contact-link">
                  arinoborba@gmail.com
                </a>
              </p>
            </div>
          </section>

          <section className="doc-section">
            <h2>2. Finalidade e Escopo da Plataforma</h2>
            <p>
              O <strong>SocialFlow</strong> tem por objetivo organizar o
              planejamento editorial, a revisão colaborativa, a aprovação interna
              de postagens e a conexão segura com canais sociais autorizados das
              marcas atendidas.
            </p>
            <p>
              O tratamento de dados é restrito à finalidade operacional de
              gestão de fluxo de trabalho e conexão voluntária com contas sociais
              autorizadas pelo cliente.
            </p>
          </section>

          <section className="doc-section">
            <h2>3. Dados Coletados</h2>
            <p>
              O SocialFlow coleta apenas o volume mínimo estritamente necessário
              de dados para fornecer seus serviços:
            </p>
            <ul>
              <li>
                <strong>Dados de Usuários da Equipe:</strong> nome, endereço de
                e-mail institucional e credenciais criptografadas de login para
                acesso à área de trabalho.
              </li>
              <li>
                <strong>Dados das Redes Sociais Conectadas:</strong> nome da
                Página do Facebook, nome de usuário e identificador da conta
                profissional do Instagram, URL de imagem de perfil pública e
                tokens de acesso necessários para a integração e gestão das
                contas autorizadas.
              </li>
              <li>
                <strong>Conteúdos para Publicação:</strong> textos de legendas,
                imagens e vídeos enviados voluntariamente pela equipe para
                compor o calendário editorial.
              </li>
              <li>
                <strong>Logs Técnicos e de Auditoria:</strong> registros de ações
                críticas (como conexão ou desconexão de canais) para segurança,
                rastreabilidade e prevenção a fraudes.
              </li>
            </ul>
          </section>

          <section className="doc-section">
            <h2>4. Integração Opcional com a Meta (Facebook e Instagram)</h2>
            <p>
              A conexão com contas da <strong>Meta</strong> (Páginas do Facebook
              e contas profissionais do Instagram) é{" "}
              <strong>totalmente opcional e voluntária</strong>.
            </p>
            <ul>
              <li>
                <strong>Consentimento Explícito:</strong> a conexão só tem
                início quando um usuário autorizado clica em &ldquo;Conectar
                Meta&rdquo; e autoriza as permissões no diálogo oficial da Meta.
              </li>
              <li>
                <strong>Sem Seleção Automática:</strong> após a autorização na
                Meta, o SocialFlow apresenta uma tela de seleção onde{" "}
                <strong>nenhuma conta vem pré-marcada</strong>. O usuário escolhe
                individual e conscientemente quais páginas ou perfis deseja
                vincular ao cliente.
              </li>
              <li>
                <strong>Sem Acesso a Senhas:</strong> o SocialFlow utiliza o
                protocolo padrão OAuth 2.0 com PKCE e tokens de acesso
                temporários concedidos pela Graph API. Nós{" "}
                <strong>nunca</strong> temos acesso à sua senha da Meta ou dados
                pessoais de amigos/seguidores.
              </li>
              <li>
                <strong>Permissões Solicitadas:</strong> solicitamos apenas as
                permissões necessárias para listar páginas administradas e
                viabilizar a gestão dos canais autorizados (ex.:{" "}
                <code>pages_show_list</code>, <code>pages_read_engagement</code>,{" "}
                <code>instagram_basic</code> e{" "}
                <code>instagram_content_publish</code>).
              </li>
            </ul>
          </section>

          <section className="doc-section">
            <h2>5. Armazenamento Seguro e Criptografia</h2>
            <p>
              Adotamos elevados padrões de segurança da informação para garantir
              que suas credenciais e conteúdos permaneçam inacessíveis a
              terceiros não autorizados:
            </p>
            <ul>
              <li>
                <strong>Criptografia em Repouso:</strong> todos os tokens de
                acesso da Meta são criptografados antes de serem gravados no
                banco de dados utilizando o algoritmo{" "}
                <strong>AES-256-GCM</strong> com vetores de inicialização (IV)
                únicos, tags de autenticação e dados autenticados adicionais
                (AAD) vinculados ao escopo do cliente.
              </li>
              <li>
                <strong>Isolamento Multitenant (RLS):</strong> utilizamos
                políticas estritas de Row Level Security (RLS) no PostgreSQL,
                garantindo que uma organização ou cliente jamais acesse dados
                ou credenciais de outro.
              </li>
              <li>
                <strong>Comunicação Cifrada:</strong> todo o tráfego é
                trafegado exclusivamente via protocolo HTTPS com certificados
                TLS modernos.
              </li>
            </ul>
          </section>

          <section className="doc-section">
            <h2>6. Compartilhamento e Não Comercialização</h2>
            <p>
              O SocialFlow <strong>não vende, não aluga e não compartilha</strong>{" "}
              dados pessoais ou dados obtidos via Meta com corretores de dados,
              redes de publicidade de terceiros ou quaisquer entidades externas.
            </p>
            <p>
              Os dados são transmitidos unicamente aos servidores da Meta (via
              Graph API oficial) para autenticação, descoberta e conexão das
              contas autorizadas pelo usuário.
            </p>
          </section>

          <section className="doc-section">
            <h2>7. Exclusão e Retenção de Dados</h2>
            <p>
              Os dados das contas sociais permanecem armazenados apenas enquanto
              o vínculo com o cliente estiver ativo no SocialFlow. Você pode
              solicitar ou efetuar a exclusão imediata de seus dados de três
              formas:
            </p>

            <div className="deletion-methods">
              <div className="deletion-card">
                <h3>Opção 1: Exclusão Direta pelo SocialFlow</h3>
                <p>
                  Na tela de gerenciamento de contas do cliente, localize a
                  conta social conectada e clique no botão{" "}
                  <strong>&ldquo;Desconectar&rdquo;</strong>. Após a confirmação
                  no diálogo, o SocialFlow apaga imediatamente e de forma
                  irrecuperável os tokens de acesso criptografados do banco de
                  dados e encerra a integração.
                </p>
              </div>

              <div className="deletion-card">
                <h3>Opção 2: Revogação pelo Facebook / Meta</h3>
                <p>
                  Você pode revogar a permissão do SocialFlow diretamente pelo
                  painel da Meta em:
                  <br />
                  <em>
                    Configurações &gt; Segurança e Login &gt; Aplicativos e Sites
                  </em>
                  . Ao remover o aplicativo SocialFlow, a Meta invalida todos os
                  tokens emitidos.
                </p>
              </div>

              <div className="deletion-card">
                <h3>Opção 3: Solicitação Formal por E-mail</h3>
                <p>
                  Para solicitar a exclusão de sua conta, histórico e dados
                  associados à sua organização, envie uma mensagem para:
                </p>
                <p>
                  <a
                    href="mailto:arinoborba@gmail.com?subject=Solicitacao%20de%20Exclusao%20de%20Dados%20SocialFlow"
                    className="contact-link"
                  >
                    arinoborba@gmail.com
                  </a>
                </p>
                <p className="muted">
                  Informe no assunto &ldquo;Solicitação de Exclusão de Dados&rdquo;
                  e indique o endereço de e-mail cadastrado e as contas a serem
                  removidas. O atendimento é efetuado diretamente pelo
                  responsável após a confirmação de titularidade da conta.
                </p>
              </div>
            </div>
          </section>

          <section className="doc-section">
            <h2>8. Seus Direitos (LGPD)</h2>
            <p>
              Em conformidade com a Lei Geral de Proteção de Dados (Lei nº
              13.709/2018 - LGPD), você tem direito a confirmar a existência de
              tratamento, acessar seus dados, corrigir dados incompletos ou
              desatualizados, revogar consentimento e solicitar a eliminação dos
              dados tratados sob seu consentimento.
            </p>
            <p>
              Para exercer qualquer um destes direitos, basta enviar uma
              mensagem para o e-mail{" "}
              <a href="mailto:arinoborba@gmail.com" className="contact-link">
                arinoborba@gmail.com
              </a>
              .
            </p>
          </section>

          <footer className="doc-article-footer">
            <p>
              SocialFlow · Gestão Editorial e Conexão Social ·{" "}
              <a href="mailto:arinoborba@gmail.com">arinoborba@gmail.com</a>
            </p>
            <p>
              <a href="/terms">Consultar Termos de Uso</a> ·{" "}
              <a href="/">Voltar à Página Inicial</a>
            </p>
          </footer>
        </article>
      </main>
    </div>
  );
}
