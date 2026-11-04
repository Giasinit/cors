import { readFileSync } from 'node:fs';
import { rootCertificates } from 'node:tls';

// RFI omits this public intermediate; keep certificate and hostname verification enabled.
export const salaBluAuthorities = [
  ...rootCertificates,
  readFileSync(new URL('../certificates/digicert-global-g2-tls-rsa-sha256-2020-ca1.pem', import.meta.url), 'utf8'),
];
