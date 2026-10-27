// Builds src/ui-client.ts with the app's Vite (S0.1). Output goes to the scratch dir in $OUT.
export default { logLevel: "warn", build: { outDir: process.env.OUT ?? "dist", emptyOutDir: true, lib: { entry: "src/ui-client.ts", formats: ["es"], fileName: "ui-client" } } };
