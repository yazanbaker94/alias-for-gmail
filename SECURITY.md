# Security

Use a separate least-privilege sending key restricted to your domain. Revoke it in the provider dashboard when no longer needed; clearing local settings does not revoke it at the provider.

Never commit real keys, browser profiles, email captures or customer data. Report vulnerabilities privately through GitHub private vulnerability reporting if enabled; do not include credentials or private emails in public issues.

The old managed AWS service is not part of this repository. Do not point this extension at old production endpoints or reuse former deployment credentials.
