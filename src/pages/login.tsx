import { useState, useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { useTranslation } from "react-i18next";
import { Eye, EyeOff } from "lucide-react";
import { Alert, Button, Checkbox, Field, Input, ThemeToggle } from "@notyet.im/ui";
import { z } from "zod";
import { signIn, useSession } from "@/lib/auth-client";
import { Logo } from "@/components/logo";
import { LanguageSwitcher } from "@/components/language-switcher";
import { useAppTheme } from "@/components/theme-provider";

/** Lucide dropped brand marks in v1, so the GitHub octocat is inlined. */
function GithubMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
    </svg>
  );
}

/**
 * Password + GitHub only.
 *
 * The design also shows a "Continue with SSO (SAML)" button. That is a Better
 * Auth plugin, independent of the harness, and is explicitly deferred — a
 * third button that 404s would be worse than its absence.
 */
export function LoginPage() {
  const { t } = useTranslation();
  const { theme, setTheme } = useAppTheme();
  // t() inside the component so the messages re-resolve on language change.
  const loginSchema = z.object({
    username: z.string().min(1, t("auth.usernameRequired")),
    password: z.string().min(1, t("auth.passwordRequired")),
  });
  const { data: session } = useSession();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const redirectTo = searchParams.get("redirect") || "/channels";

  const [formData, setFormData] = useState({ username: "", password: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [showPw, setShowPw] = useState(false);
  const [githubOAuth, setGithubOAuth] = useState(false);

  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then((c) => setGithubOAuth(c.githubOAuth))
      .catch(() => {});
  }, []);

  if (session) {
    navigate(redirectTo, { replace: true });
    return null;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setErrors({});

    const result = loginSchema.safeParse(formData);
    if (!result.success) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of result.error.issues) {
        fieldErrors[String(issue.path[0])] = issue.message;
      }
      setErrors(fieldErrors);
      return;
    }

    setSubmitting(true);
    try {
      const res = await signIn.username({
        username: formData.username,
        password: formData.password,
      });
      if (res.error) {
        setError(res.error.message ?? t("auth.signInFailed"));
        return;
      }
      navigate(redirectTo);
    } catch {
      setError(t("auth.unexpectedError"));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleGitHubLogin() {
    await signIn.social({ provider: "github", callbackURL: redirectTo });
  }

  return (
    <div
      style={{
        minHeight: "100dvh",
        width: "100%",
        display: "flex",
        background: "var(--ny-bg)",
        color: "var(--ny-text)",
        fontFamily: "var(--ny-font-sans)",
      }}
    >
      <div style={{ position: "fixed", top: 16, right: 16, display: "flex", gap: 6, zIndex: 100 }}>
        <LanguageSwitcher />
        <ThemeToggle theme={theme} onChange={setTheme} label={t("nav.toggleTheme")} />
      </div>

      {/* Form side */}
      <div
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "40px 24px",
        }}
      >
        <div style={{ width: 360, maxWidth: "100%" }}>
          <div style={{ marginBottom: 26 }}>
            <Logo />
          </div>

          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, letterSpacing: "-.01em" }}>
            {t("auth.title")}
          </h1>
          <p style={{ margin: "5px 0 0", fontSize: 12.5, color: "var(--ny-text-subtle)" }}>
            {t("auth.subtitle")}
          </p>

          {error && (
            <div style={{ marginTop: 16 }}>
              <Alert tone="danger" onDismiss={() => setError("")}>
                {error}
              </Alert>
            </div>
          )}

          <form
            onSubmit={handleSubmit}
            style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 20 }}
          >
            <Field label={t("auth.usernameLabel")} error={errors.username}>
              <Input
                value={formData.username}
                onChange={(value) => setFormData((prev) => ({ ...prev, username: value }))}
                placeholder={t("auth.usernamePlaceholder")}
                autoComplete="username"
              />
            </Field>

            <Field label={t("auth.passwordLabel")} error={errors.password}>
              <Input
                type={showPw ? "text" : "password"}
                value={formData.password}
                onChange={(value) => setFormData((prev) => ({ ...prev, password: value }))}
                placeholder={t("auth.passwordPlaceholder")}
                autoComplete="current-password"
                suffix={
                  <span
                    role="button"
                    tabIndex={0}
                    aria-label={t("auth.togglePassword")}
                    onClick={() => setShowPw((v) => !v)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") setShowPw((v) => !v);
                    }}
                    style={{
                      display: "grid",
                      placeItems: "center",
                      cursor: "pointer",
                      pointerEvents: "auto",
                      color: "var(--ny-text-subtle)",
                    }}
                  >
                    {showPw ? <EyeOff size={15} /> : <Eye size={15} />}
                  </span>
                }
              />
            </Field>

            {/* Better Auth's cookie lifetime is server-configured, so this is a
             * statement of what already happens rather than a control. It stays
             * because its absence reads as "you will be signed out". */}
            <Checkbox defaultChecked disabled label={t("auth.keepSignedIn")} />

            <Button type="submit" variant="primary" size="lg" fullWidth loading={submitting}>
              {submitting ? t("auth.loading") : t("auth.signIn")}
            </Button>
          </form>

          {githubOAuth && (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "20px 0" }}>
                <div style={{ flex: 1, height: 1, background: "var(--ny-border)" }} />
                <span
                  style={{
                    fontSize: 10.5,
                    fontFamily: "var(--ny-font-mono)",
                    textTransform: "uppercase",
                    letterSpacing: ".06em",
                    color: "var(--ny-text-subtle)",
                  }}
                >
                  {t("auth.orContinueWith")}
                </span>
                <div style={{ flex: 1, height: 1, background: "var(--ny-border)" }} />
              </div>

              <Button
                variant="secondary"
                size="lg"
                fullWidth
                onClick={handleGitHubLogin}
                iconStart={<GithubMark />}
              >
                {t("auth.github")}
              </Button>
            </>
          )}

          <p
            style={{
              fontSize: 11.5,
              color: "var(--ny-text-subtle)",
              marginTop: 22,
              lineHeight: 1.5,
            }}
          >
            {t("auth.inviteOnly")}
          </p>
        </div>
      </div>

      {/* Brand side. A container query would be wrong here — this pane is a
       * function of the viewport, not of a parent box — so it is the one media
       * query on the screen, hiding the pane below the `lg` breakpoint. */}
      <div className="bh-login-aside">
        <div style={{ width: "100%", maxWidth: 420 }}>
          <div
            style={{
              fontSize: 11,
              fontFamily: "var(--ny-font-mono)",
              textTransform: "uppercase",
              letterSpacing: ".07em",
              color: "var(--ny-text-subtle)",
              marginBottom: 10,
            }}
          >
            {t("auth.pitchEyebrow")}
          </div>
          <div style={{ fontSize: 21, fontWeight: 700, lineHeight: 1.35, letterSpacing: "-.01em" }}>
            {t("auth.pitchHeadline")}
          </div>

          <div
            style={{
              marginTop: 20,
              border: "1px solid var(--ny-ink-4)",
              borderRadius: 12,
              overflow: "hidden",
              background: "var(--ny-ink-0)",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 9,
                padding: "8px 12px",
                background: "var(--ny-ink-1)",
                borderBottom: "1px solid var(--ny-ink-4)",
              }}
            >
              {["#ff5f57", "#febc2e", "#28c840"].map((c) => (
                <span key={c} style={{ width: 9, height: 9, borderRadius: "50%", background: c }} />
              ))}
              <span
                style={{
                  fontFamily: "var(--ny-font-mono)",
                  fontSize: 11,
                  color: "var(--ny-ink-7)",
                  marginLeft: 4,
                }}
              >
                @scout · attached
              </span>
            </div>
            <div
              style={{
                padding: "12px 14px",
                fontFamily: "var(--ny-font-mono)",
                fontSize: 12,
                lineHeight: 1.75,
                color: "var(--ny-ink-8)",
              }}
            >
              <div style={{ color: "var(--ny-ink-6)" }}>✷ claude-code · gVisor sandbox</div>
              <div style={{ marginTop: 6 }}>
                <span style={{ color: "#28c840" }}>⏺</span> Read(
                <span style={{ color: "#e0af68" }}>src/db/schema.ts</span>){" "}
                <span style={{ color: "var(--ny-ink-6)" }}>→ 340 lines</span>
              </div>
              <div>
                <span style={{ color: "#28c840" }}>⏺</span> Ran(
                <span style={{ color: "#e0af68" }}>npm test</span>){" "}
                <span style={{ color: "var(--ny-ink-6)" }}>→ 34 passed</span>
              </div>
              <div style={{ marginTop: 6 }}>
                ❯{" "}
                <span
                  style={{
                    display: "inline-block",
                    width: 7,
                    height: 13,
                    background: "var(--ny-ink-8)",
                    verticalAlign: "middle",
                    animation: "nyBlink 1.1s step-end infinite",
                  }}
                />
              </div>
            </div>
          </div>

          <div
            style={{
              display: "flex",
              gap: 16,
              marginTop: 18,
              flexWrap: "wrap",
              fontFamily: "var(--ny-font-mono)",
              fontSize: 11,
              color: "var(--ny-text-subtle)",
            }}
          >
            <span>· {t("auth.pitchRealTerminal")}</span>
            <span>· {t("auth.pitchSandboxed")}</span>
            <span>· {t("auth.pitchApproved")}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
