import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/index.ts',
        'src/collectors/aws-client.ts',
        'src/collectors/types.ts',
        'src/jev/**',
        'src/core/index.ts',
        'src/core/jev/types.ts',
        'src/core/jev/typesafe-native.ts',
        'src/schemas/cost.ts',
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        statements: 80,
        branches: 75,
      },
    },
  },
});
