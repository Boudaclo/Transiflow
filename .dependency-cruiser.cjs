// Règle d'architecture (ADR-001) : un module n'importe un autre module
// que par son interface publique (src/modules/<nom>/index.ts).
module.exports = {
  forbidden: [
    {
      name: 'module-boundary',
      comment: "Accès à l'intérieur d'un autre module interdit : passer par son index.ts",
      severity: 'error',
      from: { path: '^apps/api/src/modules/([^/]+)/' },
      to: {
        path: '^apps/api/src/modules/[^/]+/',
        pathNot: ['^apps/api/src/modules/$1/', '^apps/api/src/modules/[^/]+/index\\.ts$'],
      },
    },
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
  ],
  options: { doNotFollow: { path: 'node_modules' } },
};
