#!/usr/bin/env bash
# Generate dedicated GPG keypair for SocialFlow automated backups
# Exports public key for VPS encryption and private key for custodian recovery
set -euo pipefail

KEY_NAME="SocialFlow Backup"
KEY_EMAIL="security@oriumdigital.com.br"
KEY_COMMENT="Automated Encrypted Backup Key"
OUTPUT_DIR="${1:-.local/recovery}"

mkdir -p "$OUTPUT_DIR"
chmod 700 "$OUTPUT_DIR"

GNUPGHOME="$OUTPUT_DIR/.gnupg"
mkdir -p "$GNUPGHOME"
chmod 700 "$GNUPGHOME"
export GNUPGHOME

cat <<EOF > "$OUTPUT_DIR/gen-key.batch"
%no-protection
Key-Type: EDDSA
Key-Curve: ed25519
Subkey-Type: ECDH
Subkey-Curve: cv25519
Name-Real: ${KEY_NAME}
Name-Comment: ${KEY_COMMENT}
Name-Email: ${KEY_EMAIL}
Expire-Date: 0
%commit
EOF

echo "Generating GPG keypair..."
gpg --batch --generate-key "$OUTPUT_DIR/gen-key.batch"
rm -f "$OUTPUT_DIR/gen-key.batch"

# Export public key for VPS
gpg --armor --export "${KEY_EMAIL}" > "$OUTPUT_DIR/socialflow-backup.pub"
chmod 644 "$OUTPUT_DIR/socialflow-backup.pub"

# Export private key for custodian
gpg --armor --export-secret-keys "${KEY_EMAIL}" > "$OUTPUT_DIR/socialflow-recovery.sec.key"
chmod 600 "$OUTPUT_DIR/socialflow-recovery.sec.key"

echo "Keys generated successfully in $OUTPUT_DIR:"
echo "Public key (for VPS): $OUTPUT_DIR/socialflow-backup.pub"
echo "Private key (KEEP SECURE OUTSIDE VPS): $OUTPUT_DIR/socialflow-recovery.sec.key"
