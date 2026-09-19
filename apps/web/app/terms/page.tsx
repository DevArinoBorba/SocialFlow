import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Termos de Uso | SocialFlow",
  description:
    "Termos de Serviço e Condições de Uso da plataforma SocialFlow.",
};

export default function TermsPage() {
  return (
    <div className="public-doc-shell">
      <header className="public-doc-header">
        <div className="public-doc-header-inner">
          <a href="/" className="wordmark" aria-label="SocialFlow Início">
            SocialFlow<span aria-hidden="true">.</span>
          </a>
          <nav aria-label="Navegação institucional" className="public-doc-nav">
            <a href="/privacy" className="public-doc-nav-link">
              Privacidade
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
            <span className="doc-badge">Termos de Serviço</span>
            <h1>Termos de Uso da Plataforma</h1>
            <p className="doc-meta muted">
              Última atualização: 19 de setembro de 2026 · Versão 1.0
            </p>
          </header>

          <section className="doc-section">
            <h2>1. Aceitação dos Termos</h2>
            <p>
              Ao acessar ou utilizar a plataforma <strong>SocialFlow</strong>,
              você e a organização que você representa concordam integralmente
              com estes Termos de Uso e com a nossa{" "}
              <a href="/privacy">Política de Privacidade</a>. Caso não concorde
              com qualquer disposição, não utilize a plataforma.
            </p>
            <p>
              Para esclarecimentos ou dúvidas sobre estes termos, entre em
              contato pelo e-mail{" "}
              <a href="mailto:arinoborba@gmail.com" className="contact-link">
                arinoborba@gmail.com
              </a>
              .
            </p>
          </section>

          <section className="doc-section">
            <h2>2. Descrição dos Serviços</h2>
            <p>
              O <strong>SocialFlow</strong> é uma ferramenta de gestão de fluxo
              de trabalho desenvolvida para equipes de marketing, criadores de
              conteúdo e agências, oferecendo recursos para:
            </p>
            <ul>
              <li>
                Organização multitenant de clientes, marcas e bibliotecas de
                mídia;
              </li>
              <li>
                Criação, revisão colaborativa e fluxo de aprovação de postagens;
              </li>
              <li>
                Conexão voluntária e gerenciamento de contas sociais autorizadas
                (Páginas do Facebook e perfis profissionais do Instagram).
              </li>
            </ul>
          </section>

          <section className="doc-section">
            <h2>3. Cadastro, Acesso e Segurança da Conta</h2>
            <p>
              O acesso ao SocialFlow é concedido por meio de credenciais
              individuais criadas pelo administrador da organização. O usuário
              é inteiramente responsável por:
            </p>
            <ul>
              <li>
                Manter o sigilo e a confidencialidade de sua senha e sessão;
              </li>
              <li>
                Não compartilhar credenciais com terceiros não autorizados;
              </li>
              <li>
                Notificar imediatamente o administrador ou o contato{" "}
                <a href="mailto:arinoborba@gmail.com">arinoborba@gmail.com</a>{" "}
                em caso de suspeita de acesso indevido ou comprometimento de
                credenciais.
              </li>
            </ul>
          </section>

          <section className="doc-section">
            <h2>4. Integrações de Terceiros (Meta: Facebook e Instagram)</h2>
            <p>
              A conexão com contas da <strong>Meta</strong> (Páginas do Facebook
              e perfis profissionais do Instagram) é opcional e regida pelas
              seguintes condições:
            </p>
            <ul>
              <li>
                <strong>Conexão Voluntária:</strong> a vinculação ocorre
                estritamente por ação explícita do usuário, por meio do fluxo
                oficial de consentimento OAuth 2.0 da Meta, sem seleção
                automática de contas.
              </li>
              <li>
                <strong>Conformidade com os Termos da Meta:</strong> o usuário
                declara possuir legitimidade e permissões de administrador para
                as Páginas e Contas Profissionais vinculadas, comprometendo-se a
                respeitar integralmente os{" "}
                <em>Termos da Plataforma Meta</em> e as{" "}
                <em>Diretrizes da Comunidade do Facebook e Instagram</em>.
              </li>
              <li>
                <strong>Desconexão a Qualquer Momento:</strong> o usuário pode
                interromper a integração quando desejar, diretamente pela
                interface do SocialFlow (botão &ldquo;Desconectar&rdquo;) ou
                pelas configurações da sua conta do Facebook.
              </li>
            </ul>
          </section>

          <section className="doc-section">
            <h2>5. Responsabilidade pelo Conteúdo</h2>
            <p>
              O usuário é o único e exclusivo responsável por todo o conteúdo
              (textos, imagens, vídeos, marcas e logotipos) carregado, aprovado
              ou publicado por meio do SocialFlow.
            </p>
            <p>
              O usuário assegura que os materiais publicados não violam
              direitos autorais, marcas registradas, direitos de imagem ou
              privacidade de terceiros, e não veiculam conteúdo ilegal,
              ofensivo, difamatório, discriminatório ou fraudulento.
            </p>
          </section>

          <section className="doc-section">
            <h2>6. Uso Aceitável e Condutas Proibidas</h2>
            <p>É expressamente proibido ao usuário do SocialFlow:</p>
            <ul>
              <li>
                Utilizar a plataforma para práticas abusivas, envio de spam ou
                atividades em desacordo com as políticas e diretrizes das
                plataformas parceiras;
              </li>
              <li>
                Tentar burlar os mecanismos de autenticação, criptografia,
                controle de acesso ou isolamento multitenant (RLS);
              </li>
              <li>
                Realizar engenharia reversa, descompilação ou ataques de
                negação de serviço (DoS) contra a infraestrutura do sistema;
              </li>
              <li>
                Utilizar a plataforma para veicular malware, phishing ou
                qualquer código malicioso.
              </li>
            </ul>
          </section>

          <section className="doc-section">
            <h2>7. Disponibilidade do Serviço e Manutenções</h2>
            <p>
              Empregamos esforços razoáveis para manter a plataforma disponível
              de forma contínua e segura. No entanto, o serviço é fornecido no
              estado em que se encontra (&ldquo;as is&rdquo;), podendo sofrer
              interrupções momentâneas para manutenções preventivas,
              atualizações ou em virtude de instabilidades nas APIs de redes
              sociais parceiras (como oscilações na Graph API da Meta).
            </p>
          </section>

          <section className="doc-section">
            <h2>8. Cancelamento e Encerramento de Contas</h2>
            <p>
              O SocialFlow reserva-se o direito de suspender ou encerrar o acesso
              de usuários ou organizações em caso de violação comprovada destes
              Termos de Uso, inadimplência contratual ou determinação legal.
            </p>
            <p>
              O usuário pode a qualquer momento desativar sua conta e solicitar a
              exclusão completa de seus dados através do e-mail{" "}
              <a href="mailto:arinoborba@gmail.com" className="contact-link">
                arinoborba@gmail.com
              </a>
              , conforme detalhado em nossa Política de Privacidade.
            </p>
          </section>

          <section className="doc-section">
            <h2>9. Limitação de Responsabilidade</h2>
            <p>
              Na máxima extensão permitida pela legislação aplicável, o
              SocialFlow não será responsável por danos indiretos, lucros
              cessantes, perda de receitas ou danos morais decorrentes do uso ou
              da impossibilidade de uso da plataforma, inclusive por eventuais
              bloqueios, desativações de contas ou sanções aplicadas
              diretamente pelas redes sociais parceiras (Meta).
            </p>
          </section>

          <section className="doc-section">
            <h2>10. Legislação Aplicável e Contato</h2>
            <p>
              Estes Termos de Uso são regidos e interpretados segundo as leis da
              República Federativa do Brasil. Para dúvidas, notificações ou
              solicitações relacionadas a estes termos, entre em contato com:
            </p>
            <div className="contact-box">
              <p>
                <strong>SocialFlow</strong>
              </p>
              <p>
                <strong>Contato / Suporte:</strong>{" "}
                <a href="mailto:arinoborba@gmail.com" className="contact-link">
                  arinoborba@gmail.com
                </a>
              </p>
            </div>
          </section>

          <footer className="doc-article-footer">
            <p>
              SocialFlow · Gestão Editorial e Conexão Social ·{" "}
              <a href="mailto:arinoborba@gmail.com">arinoborba@gmail.com</a>
            </p>
            <p>
              <a href="/privacy">Consultar Política de Privacidade</a> ·{" "}
              <a href="/">Voltar à Página Inicial</a>
            </p>
          </footer>
        </article>
      </main>
    </div>
  );
}
