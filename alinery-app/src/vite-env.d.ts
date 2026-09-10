/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ALINERY_DEV_LAUNCH_ROOT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
