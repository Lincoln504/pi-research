#!/bin/bash
set -e

echo "📝 Adding copyright headers to source files..."

# Copyright header
HEADER='/**
 * pi-research - Multi-agent research orchestration extension for pi
 *
 * Copyright (c) 2026 Lincoln504
 *
 * MIT License - See LICENSE file for details
 */

'

# Find all TypeScript files in src/
find src/ -name "*.ts" -type f | while read -r file; do
    # Check if file already has a copyright header
    if ! head -5 "$file" | grep -q "Copyright (c)"; then
        echo "Adding header to $file"
        # Create temp file with header + original content
        echo "$HEADER" | cat - "$file" > "${file}.tmp"
        mv "${file}.tmp" "$file"
    else
        echo "✓ $file already has copyright header"
    fi
done

echo ""
echo "✓ Copyright headers added to all source files"
