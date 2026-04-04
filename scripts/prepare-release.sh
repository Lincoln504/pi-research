#!/bin/bash
set -e

echo "🚀 Preparing pi-research for release..."
echo ""

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Parse version argument
VERSION=${1:-""}
if [ -z "$VERSION" ]; then
    echo -e "${YELLOW}Usage: ./scripts/prepare-release.sh VERSION${NC}"
    echo "Example: ./scripts/prepare-release.sh 2.0.0"
    exit 1
fi

# Validate version format
if ! [[ $VERSION =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo -e "${RED}Error: Version must be in format X.Y.Z${NC}"
    exit 1
fi

echo -e "${GREEN}✓${NC} Version: v$VERSION"
echo ""

# Step 1: Run tests
echo -e "${YELLOW}Running tests...${NC}"
npm test
echo -e "${GREEN}✓${NC} Tests passed"
echo ""

# Step 2: Type check
echo -e "${YELLOW}Running type check...${NC}"
npm run type-check
echo -e "${GREEN}✓${NC} Type check passed"
echo ""

# Step 3: Lint
echo -e "${YELLOW}Running linter...${NC}"
npm run lint
echo -e "${GREEN}✓${NC} Linting passed"
echo ""

# Step 4: Security audit
echo -e "${YELLOW}Running security audit...${NC}"
npm audit || echo -e "${YELLOW}⚠ Warning: Security vulnerabilities found${NC}"
echo ""

# Step 5: Check for outdated dependencies
echo -e "${YELLOW}Checking for outdated dependencies...${NC}"
npm outdated || echo -e "${GREEN}✓${NC} All dependencies up to date"
echo ""

# Step 6: Update version in package.json
echo -e "${YELLOW}Updating version to v$VERSION in package.json...${NC}"
npm version "$VERSION" --no-git-tag-version
echo -e "${GREEN}✓${NC} Version updated"
echo ""

# Step 7: Check required files
echo -e "${YELLOW}Checking required files...${NC}"
required_files=("LICENSE" "README.md" "CONTRIBUTING.md" "CHANGELOG.md")
for file in "${required_files[@]}"; do
    if [ -f "$file" ]; then
        echo -e "${GREEN}✓${NC} $file exists"
    else
        echo -e "${RED}✗${NC} $file is missing"
        exit 1
    fi
done
echo ""

# Step 8: Check GitHub workflows
echo -e "${YELLOW}Checking GitHub workflows...${NC}"
if [ -d ".github/workflows" ]; then
    echo -e "${GREEN}✓${NC} .github/workflows exists"
    workflows=("ci.yml" "release.yml" "setup-labels.yml")
    for wf in "${workflows[@]}"; do
        if [ -f ".github/workflows/$wf" ]; then
            echo -e "${GREEN}✓${NC} $wf exists"
        else
            echo -e "${YELLOW}⚠${NC} $wf is missing"
        fi
    done
else
    echo -e "${RED}✗${NC} .github/workflows directory is missing"
    exit 1
fi
echo ""

# Step 9: Check issue templates
echo -e "${YELLOW}Checking issue templates...${NC}"
if [ -d ".github/ISSUE_TEMPLATE" ]; then
    echo -e "${GREEN}✓${NC} .github/ISSUE_TEMPLATE exists"
    templates=("bug_report.md" "feature_request.md" "general_issue.md")
    for tpl in "${templates[@]}"; do
        if [ -f ".github/ISSUE_TEMPLATE/$tpl" ]; then
            echo -e "${GREEN}✓${NC} $tpl exists"
        else
            echo -e "${YELLOW}⚠${NC} $tpl is missing"
        fi
    done
else
    echo -e "${RED}✗${NC} .github/ISSUE_TEMPLATE directory is missing"
fi
echo ""

# Summary
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}✓ Release preparation complete!${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo "Next steps:"
echo "1. Review the changes:"
echo "   git diff"
echo ""
echo "2. Update CHANGELOG.md with release notes"
echo ""
echo "3. Commit the changes:"
echo "   git add ."
echo "   git commit -m \"chore: prepare for v$VERSION release\""
echo ""
echo "4. Create and push the tag:"
echo "   git tag -a v$VERSION -m \"Release v$VERSION\""
echo "   git push origin main"
echo "   git push origin v$VERSION"
echo ""
echo "5. The release workflow will automatically create a GitHub Release"
echo ""
echo -e "${YELLOW}Don't forget to set up branch protection in GitHub Settings!${NC}"
