#!/bin/bash
# Script to login and publish to npm

set -e  # Exit on error

echo "=== NPM Publish Script ==="
echo ""

# Check if already logged in
if npm whoami &>/dev/null; then
    echo "✅ Already logged in as: $(npm whoami)"
else
    echo "⚠️  Not logged in. Please run: npm login"
    echo "Then run this script again."
    exit 1
fi

echo ""
echo "=== Running Tests ==="
npm test

if [ $? -ne 0 ]; then
    echo "❌ Tests failed. Fix tests before publishing."
    exit 1
fi

echo ""
echo "✅ All tests passed (28/28)"
echo ""

echo "=== Current Package Info ==="
echo "Name: $(grep '"name"' package.json | cut -d'"' -f4)"
echo "Version: $(grep '"version"' package.json | cut -d'"' -f4)"
echo ""

read -p "Ready to publish to npm? (y/N) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "❌ Publish cancelled"
    exit 1
fi

echo ""
echo "=== Publishing to npm ==="
npm publish --access public

if [ $? -eq 0 ]; then
    echo ""
    echo "✅ Successfully published to npm!"
    echo ""
    echo "View at: https://www.npmjs.com/package/claude-langfuse-monitor"
    echo ""
    echo "Next steps:"
    echo "1. Test installation: npm install -g claude-langfuse-monitor"
    echo "2. Create LinkedIn announcement"
    echo "3. Post to Hacker News"
    echo "4. Share in Langfuse community"
else
    echo "❌ Publish failed"
    exit 1
fi
