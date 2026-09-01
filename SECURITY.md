# Security

Report suspected CARS vulnerabilities privately to the repository maintainers
through GitHub's private vulnerability reporting interface. Do not include
wallet keys, database URLs, deployment signatures, Kubernetes tokens, or other
live credentials in a public issue.

Supported production releases are built from merged `master` commits. Each
release build runs the test suite, audits production npm dependencies, scans
the resulting OCI image for high and critical vulnerabilities, and publishes
an SBOM with its immutable source/image manifest.
