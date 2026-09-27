# Quillmark

> Quillmark is a TypeScript library for rendering Markdown to accessible HTML, with plugins for math, diagrams and syntax highlighting.

Important notes:

- Quillmark 3 replaced the `render()` function with `createRenderer().render()`; examples using the old API will not work.
- Plugins are ES modules only; there is no CommonJS build.

## Docs

- [Quick start](https://quillmark.dev/docs/quickstart.md): install, render your first document
- [Plugin API](https://quillmark.dev/docs/plugins.md): writing and registering plugins
- [Accessibility](https://quillmark.dev/docs/a11y.md): heading levels, alt text, ARIA output

## Examples

- [Blog engine](https://github.com/quillmark/examples/blob/main/blog/README.md): a static blog built with Quillmark

## Optional

- [Changelog](https://quillmark.dev/changelog.md)
