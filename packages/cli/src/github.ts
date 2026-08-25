export interface GitHubWorkflowInput {
  configFile: string;
  contractFile: string;
  packageManager: "npm" | "pnpm";
  authorityPackage: string;
  reporterId: string;
  privateKeySecret: string;
}

function safeValue(value: string, label: string, pattern: RegExp): string {
  if (!pattern.test(value)) throw new Error(`${label} contains unsupported characters.`);
  return value;
}

export function renderGitHubWorkflow(input: GitHubWorkflowInput): string {
  const config = safeValue(input.configFile, "Configuration path", /^[A-Za-z0-9._/-]+$/);
  const contract = safeValue(input.contractFile, "Contract path", /^[A-Za-z0-9._/-]+$/);
  const reporter = safeValue(input.reporterId, "Reporter identity", /^[A-Za-z0-9._-]+$/);
  const secret = safeValue(input.privateKeySecret, "Private-key secret name", /^[A-Z_][A-Z0-9_]*$/);
  const authorityPackage = safeValue(
    input.authorityPackage,
    "Authority package",
    /^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+@\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/,
  );
  const install =
    input.packageManager === "pnpm"
      ? [
          "      - uses: pnpm/action-setup@0e279bb959325dab635dd2c09392533439d90093 # v6.0.8",
          "        with:",
          "          version: 11",
          "      - uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6.4.0",
          "        with:",
          "          node-version: 22",
          "          cache: pnpm",
          "      - run: pnpm install --frozen-lockfile",
        ]
      : [
          "      - uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6.4.0",
          "        with:",
          "          node-version: 22",
          "          cache: npm",
          "      - run: npm ci",
        ];
  return [
    "name: Trust authority",
    "",
    "on:",
    "  pull_request_target:",
    "    types: [opened, synchronize, reopened]",
    "",
    "permissions:",
    "  contents: read",
    "",
    "concurrency:",
    "  group: trust-${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}",
    "  cancel-in-progress: true",
    "",
    "jobs:",
    "  evidence:",
    "    runs-on: ubuntu-latest",
    "    timeout-minutes: 30",
    "    steps:",
    "      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2",
    "        with:",
    "          ref: ${{ github.event.pull_request.head.sha }}",
    "          fetch-depth: 0",
    "          persist-credentials: false",
    ...install,
    `      - run: npm install --global ${authorityPackage} --ignore-scripts --registry=https://registry.npmjs.org`,
    `      - run: trust doctor --config ${config} --contract ${contract}`,
    "      - name: Verify approved intent",
    "        id: trust",
    "        continue-on-error: true",
    "        run: >-",
    "          trust verify",
    `          --config ${config}`,
    `          --contract ${contract}`,
    "          --base ${{ github.event.pull_request.base.sha }}",
    "          --output .trust/runs/evidence",
    "      - uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1",
    "        if: always()",
    "        with:",
    "          name: trust-evidence-${{ github.run_id }}-${{ github.run_attempt }}",
    "          path: .trust/runs/evidence",
    "          if-no-files-found: error",
    "          retention-days: 30",
    "",
    "  attest:",
    "    needs: evidence",
    "    if: always()",
    "    runs-on: ubuntu-latest",
    "    timeout-minutes: 10",
    "    environment: trust-authority",
    "    steps:",
    "      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2",
    "        with:",
    "          ref: ${{ github.event.pull_request.head.sha }}",
    "          fetch-depth: 0",
    "          persist-credentials: false",
    "          path: candidate",
    "      - uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6.4.0",
    "        with:",
    "          node-version: 22",
    `      - run: npm install --global ${authorityPackage} --ignore-scripts --registry=https://registry.npmjs.org`,
    "      - uses: actions/download-artifact@37930b1c2abaa49bbe596cd826c3c89aef350131 # v7.0.0",
    "        with:",
    "          name: trust-evidence-${{ github.run_id }}-${{ github.run_attempt }}",
    "          path: .trust/input",
    "      - name: Attest in isolated trust context",
    "        id: trust",
    "        env:",
    `          TRUST_REPORT_PRIVATE_KEY: \${{ secrets.${secret} }}`,
    "        run: >-",
    "          trust report:attest .trust/input/report.json",
    `          --config candidate/${config}`,
    '          --expected-policy-sha256 "${{ vars.TRUST_POLICY_SHA256 }}"',
    "          --key-env TRUST_REPORT_PRIVATE_KEY",
    `          --signer ${reporter}`,
    "          --output .trust/attested/report.json",
    "          --require-trusted",
    "      - run: >-",
    "          trust report:verify .trust/attested/report.json",
    `          --config candidate/${config}`,
    '          --expected-policy-sha256 "${{ vars.TRUST_POLICY_SHA256 }}"',
    "          --require-trusted",
    "      - uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1",
    "        if: always()",
    "        with:",
    "          name: trust-attested-${{ github.run_id }}-${{ github.run_attempt }}",
    "          path: .trust/attested",
    "          if-no-files-found: warn",
    "          retention-days: 30",
    "",
  ].join("\n");
}
