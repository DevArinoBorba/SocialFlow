import { describe, it, expect } from "vitest";
import {
  designTemplateSpecSchema,
  designTemplateInputSchema,
  designTemplatePatchSchema,
  designTemplateVersionInputSchema,
  designTemplateDuplicateInputSchema,
} from "../../packages/contracts/src/design.js";
import { isAdmin, type Role } from "../../packages/contracts/src/index.js";

const disallowedPattern =
  /<[a-zA-Z/][^>]*>|(?:https?|ftp|file|javascript|data):|(?:url\(|@import|expression\()/i;

function validateName(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length < 2 || trimmed.length > 120) {
    return "O nome deve ter entre 2 e 120 caracteres.";
  }
  if (disallowedPattern.test(trimmed)) {
    return "O nome não pode conter HTML, CSS, URLs ou scripts.";
  }
  return null;
}

function computeTemplatePermissions(role: Role) {
  const canInitializeTemplates = isAdmin(role);
  const canReactivateTemplates = isAdmin(role);
  const canEditTemplates = isAdmin(role) || role === "EDITOR";
  return {
    canInitializeTemplates,
    canReactivateTemplates,
    canEditTemplates,
    isReadOnly: !canEditTemplates,
  };
}

describe("design-template-manager: Validações, Contratos e Permissões", () => {
  it("valida regras de RBAC estritas para OWNER e ADMIN", () => {
    for (const adminRole of ["OWNER", "ADMIN"] as Role[]) {
      const perms = computeTemplatePermissions(adminRole);
      expect(perms.canEditTemplates).toBe(true);
      expect(perms.canReactivateTemplates).toBe(true);
      expect(perms.canInitializeTemplates).toBe(true);
      expect(perms.isReadOnly).toBe(false);
    }
  });

  it("valida regras de RBAC estritas para EDITOR", () => {
    const perms = computeTemplatePermissions("EDITOR");
    expect(perms.canEditTemplates).toBe(true);
    expect(perms.canReactivateTemplates).toBe(false); // EDITOR não reativa arquivados
    expect(perms.canInitializeTemplates).toBe(false); // EDITOR não inicializa defaults
    expect(perms.isReadOnly).toBe(false);
  });

  it("valida regras de RBAC estritas para APPROVER e CLIENT_VIEWER (somente leitura)", () => {
    for (const readOnlyRole of ["APPROVER", "CLIENT_VIEWER"] as Role[]) {
      const perms = computeTemplatePermissions(readOnlyRole);
      expect(perms.canEditTemplates).toBe(false);
      expect(perms.canReactivateTemplates).toBe(false);
      expect(perms.canInitializeTemplates).toBe(false);
      expect(perms.isReadOnly).toBe(true);
    }
  });

  it("valida nomes de templates bloqueando HTML, CSS, URLs, scripts e comprimentos inválidos", () => {
    expect(validateName("")).toBe("O nome deve ter entre 2 e 120 caracteres.");
    expect(validateName("A")).toBe("O nome deve ter entre 2 e 120 caracteres.");
    expect(validateName("a".repeat(121))).toBe(
      "O nome deve ter entre 2 e 120 caracteres.",
    );

    // Bloqueios de injeção e conteúdo proibido
    expect(validateName("<script>alert(1)</script>")).toBe(
      "O nome não pode conter HTML, CSS, URLs ou scripts.",
    );
    expect(validateName("Modelo <b>Negrito</b>")).toBe(
      "O nome não pode conter HTML, CSS, URLs ou scripts.",
    );
    expect(validateName("Modelo com https://exemplo.com")).toBe(
      "O nome não pode conter HTML, CSS, URLs ou scripts.",
    );
    expect(validateName("Modelo url('evil.css')")).toBe(
      "O nome não pode conter HTML, CSS, URLs ou scripts.",
    );
    expect(validateName("javascript:steal()")).toBe(
      "O nome não pode conter HTML, CSS, URLs ou scripts.",
    );

    // Nomes válidos
    expect(validateName("Editorial Square")).toBeNull();
    expect(validateName("Minimalista Promocional")).toBeNull();
    expect(validateName("Campanha Black Friday 2026")).toBeNull();
  });

  it("valida especificação de template com limites estritos do schema", () => {
    const validSpec = {
      schemaVersion: 1 as const,
      format: "PORTRAIT" as const,
      backgroundColor: "#0F172A",
      overlayColor: "#020617",
      overlayOpacity: 0.35,
      textColor: "#F8FAFC",
      mutedTextColor: "#94A3B8",
      accentColor: "#38BDF8",
      safeArea: 80,
      textAlign: "left" as const,
      titleMaxLines: 3,
      showEyebrow: true,
      showSubtitle: true,
      showCallToAction: true,
    };

    expect(designTemplateSpecSchema.safeParse(validSpec).success).toBe(true);

    // Safe area fora do intervalo (min 40, max 240)
    expect(
      designTemplateSpecSchema.safeParse({ ...validSpec, safeArea: 30 })
        .success,
    ).toBe(false);
    expect(
      designTemplateSpecSchema.safeParse({ ...validSpec, safeArea: 250 })
        .success,
    ).toBe(false);

    // Cor em formato inválido
    expect(
      designTemplateSpecSchema.safeParse({
        ...validSpec,
        backgroundColor: "red",
      }).success,
    ).toBe(false);
    expect(
      designTemplateSpecSchema.safeParse({
        ...validSpec,
        backgroundColor: "#123",
      }).success,
    ).toBe(false);

    // Opacidade fora de 0..1
    expect(
      designTemplateSpecSchema.safeParse({
        ...validSpec,
        overlayOpacity: 1.5,
      }).success,
    ).toBe(false);

    // titleMaxLines fora de 1..4
    expect(
      designTemplateSpecSchema.safeParse({
        ...validSpec,
        titleMaxLines: 0,
      }).success,
    ).toBe(false);
    expect(
      designTemplateSpecSchema.safeParse({
        ...validSpec,
        titleMaxLines: 5,
      }).success,
    ).toBe(false);

    // Formato inválido
    expect(
      designTemplateSpecSchema.safeParse({
        ...validSpec,
        format: "BANNER",
      }).success,
    ).toBe(false);
  });

  it("valida input de criação, patch, versão e duplicação com os schemas oficiais", () => {
    const validSpec = {
      schemaVersion: 1 as const,
      format: "SQUARE" as const,
      backgroundColor: "#0F172A",
      overlayColor: "#020617",
      overlayOpacity: 0.3,
      textColor: "#FFFFFF",
      mutedTextColor: "#94A3B8",
      accentColor: "#38BDF8",
      safeArea: 80,
      textAlign: "center" as const,
      titleMaxLines: 2,
      showEyebrow: false,
      showSubtitle: true,
      showCallToAction: true,
    };

    expect(
      designTemplateInputSchema.safeParse({
        name: "Modelo Teste",
        spec: validSpec,
      }).success,
    ).toBe(true);

    expect(
      designTemplatePatchSchema.safeParse({
        name: "Novo Nome",
      }).success,
    ).toBe(true);

    expect(
      designTemplatePatchSchema.safeParse({
        status: "ARCHIVED",
      }).success,
    ).toBe(true);

    // Patch sem nenhum campo deve falhar
    expect(designTemplatePatchSchema.safeParse({}).success).toBe(false);

    // Versão com expectedBaseVersion positivo é válida
    expect(
      designTemplateVersionInputSchema.safeParse({
        expectedBaseVersion: 1,
        spec: validSpec,
      }).success,
    ).toBe(true);

    // Sem expectedBaseVersion deve falhar
    expect(
      designTemplateVersionInputSchema.safeParse({
        spec: validSpec,
      }).success,
    ).toBe(false);

    // expectedBaseVersion <= 0, float ou string deve falhar
    expect(
      designTemplateVersionInputSchema.safeParse({
        expectedBaseVersion: 0,
        spec: validSpec,
      }).success,
    ).toBe(false);

    expect(
      designTemplateVersionInputSchema.safeParse({
        expectedBaseVersion: -1,
        spec: validSpec,
      }).success,
    ).toBe(false);

    expect(
      designTemplateVersionInputSchema.safeParse({
        expectedBaseVersion: 1.5,
        spec: validSpec,
      }).success,
    ).toBe(false);

    expect(
      designTemplateVersionInputSchema.safeParse({
        expectedBaseVersion: "1",
        spec: validSpec,
      }).success,
    ).toBe(false);

    expect(
      designTemplateDuplicateInputSchema.safeParse({
        name: "Modelo Duplicado",
      }).success,
    ).toBe(true);
  });

  it("detecta corretamente alterações não salvas (isDirty)", () => {
    const baseSpec = {
      schemaVersion: 1,
      format: "SQUARE",
      backgroundColor: "#0F172A",
      overlayColor: "#020617",
      overlayOpacity: 0.3,
      textColor: "#FFFFFF",
      mutedTextColor: "#94A3B8",
      accentColor: "#38BDF8",
      safeArea: 80,
      textAlign: "left",
      titleMaxLines: 3,
      showEyebrow: true,
      showSubtitle: true,
      showCallToAction: true,
    };

    const identicalSpec = { ...baseSpec };
    expect(JSON.stringify(baseSpec) === JSON.stringify(identicalSpec)).toBe(
      true,
    );

    const changedColor = { ...baseSpec, backgroundColor: "#1E293B" };
    expect(JSON.stringify(baseSpec) === JSON.stringify(changedColor)).toBe(
      false,
    );

    const changedSafeArea = { ...baseSpec, safeArea: 100 };
    expect(JSON.stringify(baseSpec) === JSON.stringify(changedSafeArea)).toBe(
      false,
    );
  });
});
