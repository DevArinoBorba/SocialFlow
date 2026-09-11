import type { Metadata } from "next";
import "./styles.css";
export const metadata: Metadata = {
  title: "SocialFlow | Clientes",
  description: "Área de trabalho da equipe",
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
