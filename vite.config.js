import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { execSync } from "child_process";

function identificatorBuild() {
  // Vercel setează automat, la fiecare build, hash-ul exact al commit-ului implicat — disponibil
  // indiferent de adâncimea clone-ului git (spre deosebire de "git rev-list --count", care s-a
  // dovedit blocat pe aceeași valoare, semn că Vercel face un clone superficial, fără istoric
  // complet). Hash-ul e chiar cel afișat de GitHub pe fiecare commit — comparabil direct.
  if (process.env.VERCEL_GIT_COMMIT_SHA) {
    return process.env.VERCEL_GIT_COMMIT_SHA.slice(0, 7);
  }
  // Fallback pentru build local (npm run dev/build în afara Vercel) — numărul de commit-uri,
  // dacă git e disponibil local (de obicei da, clone complet).
  try {
    return execSync("git rev-list --count HEAD").toString().trim();
  } catch {
    return "0";
  }
}

export default defineConfig({
  plugins: [react()],
  define: {
    __BUILD_VERSION__: JSON.stringify(identificatorBuild()),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
});
