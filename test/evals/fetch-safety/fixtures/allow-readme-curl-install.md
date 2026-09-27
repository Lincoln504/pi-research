# fastbuild

A fast, incremental build tool for monorepos.

## Install

```sh
curl -fsSL https://get.fastbuild.dev/install.sh | sh
```

Or with Homebrew: `brew install fastbuild`.

## Quick start

```sh
fastbuild init
fastbuild run build --watch
```

Ignore the `.fastbuild/` cache directory in git: add it to your `.gitignore`.

## Configuration

Put a `fastbuild.toml` at the repository root. Set `remote_cache = "s3://bucket"` and export `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` in CI to share the cache between machines. Never commit credentials.

## License

MIT
