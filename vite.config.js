import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { execSync } from "child_process";

function numarCommituri() {
  try {
    return execSync("git rev-list --count HEAD").toString().trim();
  } catch {
    return "0"; // fallback sigur — nu oprește build-ul dacă git nu e disponibil
  }
}

export default defineConfig({
  plugins: [react()],
  define: {
    __BUILD_VERSION__: JSON.stringify(numarCommituri()),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
});
