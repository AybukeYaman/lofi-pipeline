import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * Web tarafı birim testleri — saf fonksiyonlar (rota çözümü, form
 * doğrulaması). Tarayıcı ortamı gerekmiyor, bu yüzden `node` ortamı.
 *
 * Arka uç testleri ayrı koşuyor (`npm test` → node --test). İkisi birlikte:
 * `npm run test:all`.
 */
export default defineConfig({
  root: 'web',
  plugins: [react()],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});
