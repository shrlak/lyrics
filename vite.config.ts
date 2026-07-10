import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { viteStaticCopy } from 'vite-plugin-static-copy';

// Deployed under https://<user>.github.io/lyrics/ via GitHub Pages.
// BASE_PATH can override for local preview or a different repo name.
const base = process.env.BASE_PATH ?? '/lyrics/';

export default defineConfig({
  base,
  plugins: [
    react(),
    viteStaticCopy({
      targets: [
        // pdf.js needs cmaps for CID-keyed fonts (e.g. Adobe-Korea1 in scanned conti PDFs)
        { src: 'node_modules/pdfjs-dist/cmaps', dest: '.' },
        { src: 'node_modules/pdfjs-dist/standard_fonts', dest: '.' },
      ],
    }),
  ],
  build: {
    target: 'es2022',
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
