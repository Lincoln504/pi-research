# 研究ドキュメント（日本語）

## Pi 拡張 {#pi-extension}

pi-research は [pi](https://github.com/earendil-works/pi) の**拡張機能**（`src/index.ts`）
として統合されます。リアルタイムのターミナル UI（TUI）を備えたマルチエージェント型
ウェブリサーチエンジンであり、pi のプロセス内に直接登録されて動作します。

### 使い方

`research` ツールは自動的に登録されるため、モデルは自然言語による指示だけでこのツールを
呼び出せます。必要なリサーチ深度（1–3）も、ツール自身がクエリの内容を読み取って判断します。

```bash
pi -p "WebAssembly の最新動向をリサーチして"
pi -p "AI 推論ハードウェアの市場状況を徹底的に調査して"
```

さらに、次の 3 つのスラッシュコマンドが登録されます。

| コマンド | 説明 |
|---------|-------------|
| `/research <クエリ>` | 設定済みのデフォルト深度（`PI_RESEARCH_DEFAULT_RESEARCH_DEPTH`、デフォルトは 1）で `research` ツールを直接呼び出します。通常のライブ実行であり、LLM のターンを経由しません。クエリ内に書かれた深度を解釈することはなく、ナレッジストアへの問い合わせも**行いません**。ストアのみを検索したい場合は `/knowledge-store <クエリ>` を使用してください。 |
| `/research-config` | 対話型の TUI 設定パネルを開きます。TUI のないホスト（RPC、web hub、print、JSON、SDK）ではメニューを表示できないため、コマンドはその理由を説明した上で、そこで動作する非対話型の診断コマンド（`/research-config health`（システムの状態）と `/research-config knowledge-status`（ナレッジストアの状態））を応答します。 |
| `/knowledge-store <クエリ>` | ローカルのナレッジストアを検索し、過去のリサーチ成果に基づいて統合された回答を返します。ナレッジモードが `none` の場合は利用できません。ストアのコンパクションは自動的に管理されるため、メンテナンス用のサブコマンドは存在しません。 |

![/research スラッシュコマンドによるライブ調査の実行](https://raw.githubusercontent.com/Lincoln504/pi-research/main/docs/media/01-slash-research.gif)

### ツール

この拡張機能は 3 つのツールを登録します。

| ツール | 登録 |
|------|-----------|
| `research` | 常時 |
| `health` | 常時 |
| `research_knowledge_search` | 常時（注記あり） |

`research_knowledge_search` は無条件に登録されます。これは、ナレッジモードを変更した際に
pi の再起動なしで変更を反映させるためです（pi にはツールの登録解除用 API がありません）。
`PI_RESEARCH_KNOWLEDGE_STORE_MODE` が `none` の場合、このツールはエージェントに
アナウンスされず、プロンプト上のガイダンスも差し挟まれず、呼び出しても「ストア無効」の
結果が返されます。`/knowledge-store` コマンドも利用できなくなります。ストアのアナウンスと
読み書きの経路は、登録時ではなく、その時点で有効なモードによって決まります。

ツールの除外: `research` ツールは、pi ホストがセッションコンテキストで渡した場合に限り、
`excludeTools` リストを尊重します。

### TUI

実行中、pi-research はリアルタイムの進行状況パネルを表示します。

- リサーチャーごとのバー — エージェント 1 体につき 1 本。状態、取得した URL、実行したアクションを表示。
- 波のアニメーション — アクティブなクロールのインジケーター。
- トークン使用量 — モデルのトークン数と推定コスト（減少防止ガード付き）。
- ステータスのフラッシュ — 成功時は緑、失敗時は赤。
- ステアリングメッセージ — 実行中にキューへ入れた、または投入したユーザーの指示。

| キー | 動作 |
|-----|--------|
| `Escape` | 実行中のリサーチをキャンセル |
| `Ctrl+C` | エディタにテキストがある場合: そのテキストのみをクリア。エディタが空の場合: 実行をキャンセル（`Escape` と同じ）。 |
| 矢印キー | `/research-config` のメニューを移動 |
| `Enter` / `Space` | 設定値を順に切り替え |

### 設定

設定は `/research-config` で管理し、2 つのレイヤーを編集します。

- グローバル — ベースファイル `~/.pi/research/config.env`（すべてのフロントエンドに適用）。
- プロジェクト — 一元管理されたプロジェクトレジストリ
  （`~/.pi/research/state/project-settings.json`）。作業ディレクトリごとに適用されます。
  プロジェクトスコープを持つのはリサーチ深度とナレッジモードのみで、これにより
  グローバル値を変更せずに、リポジトリ固有のリサーチ深度を持たせられます。

pi 拡張機能を他のフロントエンドとは独立して設定するには、任意のオーバーレイファイルを
`~/.pi/research/pi.env` に置きます（pi 拡張機能に限り、`config.env` の上に積み重ねられます）。
設定モデルの全体像、優先順位、環境変数の完全な一覧は[設定](#configuration)を参照してください。

### エージェントスキルインストーラー

`/research-config` のメニューから、このマシンで検出された他のコーディングエージェントに
`pi-research` スキルをインストール（CLI 経由でウェブリサーチを実行させる）したり、
逆にアンインストールしたりできます。アンインストールはマニフェストに基づく正確なクリーンアップで
行われます。インストールの全フローは[エージェントスキル](#agent-skill)を参照してください。

### ライフサイクル

- `activate` — コマンド・ツール・TUI コントローラーを登録し、サービスを初期化します。
- `deactivate` — 書き込みキューをフラッシュし、LanceDB を閉じ、ブラウザプールを終了し、
  埋め込みモデルを破棄します。
- `session_shutdown` — `event.reason` に応じて分岐します。`quit` はプロセス終了時の
  クリーンアップを起動し、reload / new / resume / fork はプロセスを終了させずにクリーンアップします。

拡張機能の状態は pi のセッションごとに分離されているため、`/reload` を安全に実行できます。

## エージェントスキル {#agent-skill}

pi-research は、持ち運び可能な
[エージェントスキル](https://agentskills.io/specification)（Agent Skill）としても配布されて
います。スキルに対応したコーディングエージェントであれば、同じ `SKILL.md`
ディレクトリ規約を使うものなら何であれ — Claude、OpenAI Codex CLI など — pi-research の
エンジンでウェブリサーチを実行できます。

### インストール

pi 拡張機能を既に使っていますか（`pi install npm:@lincoln504/pi-research`）？エンジンは
すでに手元にあります — `/research-config` →「外部エージェントへインストール」で他の
エージェントにスキルをインストールしてください（[インストールフロー](#インストールフロー)参照）。
以下のインストールコマンドは不要です。ただしモデルの設定は依然として必要です。スキルは
pi セッションのモデルではなく、設定された独自の `PI_RESEARCH_MODEL` で実行されるためです。

pi を使わずスタンドアロンで利用する場合は、エンジンをグローバルにインストールし、この
マシンで検出された各コーディングエージェントにスキルをリンクします。

```bash
npm install -g @lincoln504/pi-research   # エンジン（`pi-research` が PATH に入る）
pi-research skill install                # 検出された各エージェントにスキルをリンク
```

npm ≥11.19（および npm 12）では、依存パッケージのインストールスクリプトはデフォルトで
スキップされます — が、ここでは不要です。better-sqlite3 13 はプリビルド済みバイナリを
自身の tarball に同梱しており、ステルスブラウザも初回使用時にセルフプロビジョニングします
（初回のダウンロードには数分かかります）。承認操作は一切不要です
（[README](https://github.com/Lincoln504/pi-research/blob/main/README.md#install) 参照）。

`skill install` は `$HOME` 配下に既に構成されているエージェントのみを対象とし、同じ場所に
ある異なるスキルを決して上書きせず、作成した内容を記録します。そのため
`pi-research skill uninstall` はその記録された内容だけを正確に削除します。どこにインストール
されたかは `pi-research skill status` で確認できます。

その後、リサーチを実行するモデルを設定します。スキルおよびスタンドアロン CLI は、明示的に
設定されたこのモデルのみを使用し（pi 拡張機能内で選択されたモデルには決して追従しません）、
設定がなければ起動を拒否します。

```sh
# ~/.pi/research/config.env  （または環境変数として export）
PI_RESEARCH_MODEL=provider/model-id
```

`pi` を使っている場合、API キーは pi の設定（`~/.pi/agent/auth.json`）から自動的に取得され
ます。それ以外は `PI_RESEARCH_API_KEY` も設定してください（同じファイル内、または環境変数）。
[設定](#configuration)を参照してください。

Windows では `pi-research` を `cmd` から実行するか、`pi-research.cmd` を使用してください。
PowerShell のデフォルト実行ポリシー（`Restricted`）は npm の `.ps1` シムをブロックします
（"running scripts is disabled"）。または
`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` を一度だけ実行してください。

![外部エージェントへのリサーチスキルのインストール](https://raw.githubusercontent.com/Lincoln504/pi-research/main/docs/media/05-agent-skill.gif)

### 仕組み

```
エージェント
  │  外部ツールとして呼び出し（Bash / exec）
  ▼
run.mjs  —  依存ゼロのランチャー（agent-skill/pi-research/scripts/）
  │  インストール済みエンジンを特定、なければ案内付きで即座に失敗
  ▼
pi-research エンジン  —  CLI（dist/cli.mjs）
  │  init → run → shutdown
  ▼
引用付き Markdown レポート  →  stdout  →  エージェントへ
```

エージェントは `SKILL.md` の `description` を読んでランチャーを実行します。`run.mjs` は
依存を持ちません。インストール済みエンジンを特定し（`PI_RESEARCH_BIN` でエンジンの
`dist/cli.mjs` を指定 → `PI_RESEARCH_PATH` でパッケージディレクトリを指定 → PATH /
`node_modules` / `~/.pi/bin` の順で探索）、パッケージ・モデル・API キーのいずれかが
見つからなければ、設定ファイルの場所を含む実行可能なメッセージとともに終了します。
4 つのサブコマンドを公開しています。`research "<クエリ>"`（ライブリサーチ）、
`knowledge "<クエリ>"`（過去の成果を検索）、`knowledge-config [set <モード>]`
（ディレクトリごとのナレッジストアモードの表示/設定）、`status`（検出と設定の確認）です。

### インストールフロー {#インストールフロー}

スキルのソースコードはパッケージ内の `agent-skill/pi-research/` にあります。インストールとは、
そのディレクトリを各エージェントのスキルフォルダへリンクすることです。

> ディレクトリをあえて `skills/` と名付けていないのには理由があります。pi はパッケージルートの
> `skills/` ディレクトリを自身のルートリソースとして扱い、そこにあるものを読み込むため、
> 結果として拡張機能のネイティブなリサーチツールが、サブプロセスで動く遅い自分自身のコピーに
> 隠されてしまうからです。

ワンクリック（推奨）。pi 拡張機能から `/research-config` →「外部エージェントへインストール」を
実行します。インストーラーは:

1. `$HOME` 配下にどのターゲットエージェントが存在するかを検出します — 現在は Claude
   （`~/.claude/skills`）、OpenAI Codex CLI（`~/.codex/skills` — このパスは Codex 公式
   ドキュメントでは未確認です。Codex のスキル対応はまだ発展途上です）、OpenClaw
   （`~/.openclaw/skills`）です。
2. 存在する各エージェントへ `agent-skill/pi-research/` をシンボリックリンクします。その場所を
   すでに占有している他人のスキルを決して上書きしません。
3. 作成した内容をマニフェストに記録します。これにより「外部エージェントから削除」を実行しても
   自分のリンクだけが取り除かれます。起動時に古いリンク（stale link）も回収されます。

> **アンインストールだけでは何も削除されません。** パッケージには `preuninstall` スクリプトが
> 含まれていますが、**npm 7 以降は `preuninstall` を実行しません** — npm 11 で確認済みです。
> `postinstall` は発火しますが、`preuninstall` は発火しません。そのため
> `npm uninstall @lincoln504/pi-research` を実行しても、スキルのリンク、状態ディレクトリ
> （`~/.pi/research/state`）、キャッシュディレクトリ（`~/.cache/pi-research`。ダウンロード済みの
> 埋め込みモデルを含みます）はその場に残ります。パッケージを削除する**前に**
> `pi-research skill uninstall` を実行して、リンクを自分で片付けてください。

スタンドアロン（pi 拡張機能なし）。`pi-research skill install` と
`pi-research skill uninstall` は CLI からまったく同じことを行います — 同じエージェント検出、
同じマニフェスト、他人のスキルを踏まない同じ保証 — `npm install -g` でエンジンを入れ、
対話的な拡張機能を開かない人のためのものです。

独自のスキル登録 CLI を持つエージェントは、シンボリックリンクの代わりに、配布ディレクトリを
直接そのエージェントに登録することもできます。エンジンをインストールし、
`$(npm root -g)/@lincoln504/pi-research/agent-skill/pi-research` をそのエージェントに
登録してください — ルートに `SKILL.md` が入っています。これはこうしたツールが期待する構成です。
リンクではなくコピーするエージェントは、エンジンの更新を次回の `skill install` で取り込みます。
自動では取り込みません。

手動。どのエージェントのスキルフォルダにもシンボリックリンクを張れます。

| エージェント | 個人 | プロジェクト |
|-------|----------|---------|
| Claude | `~/.claude/skills/pi-research/` | `<project>/.claude/skills/pi-research/` |
| OpenAI Codex CLI | `~/.codex/skills/pi-research/` | `<project>/.codex/skills/pi-research/` |
| OpenClaw | `~/.openclaw/skills/pi-research/` | `<workspace>/skills/pi-research/` |

### 前提条件

- Node.js >= 22.19.0
- ランチャーから見つけられる場所にインストールされた `pi-research` に加え、設定済みのモデル
  （`PI_RESEARCH_MODEL`）と API キー。[設定](#configuration)を参照してください。

```bash
npm install -g @lincoln504/pi-research
node "<skill_dir>/scripts/run.mjs" status   # エンジンが検出されるか確認
```

![ワンコマンドでのステータス確認とセットアップ](https://raw.githubusercontent.com/Lincoln504/pi-research/main/docs/media/06-health-check.gif)

インストール後は、エージェントに何かを調べるよう依頼するだけです — スキルシステムが
pi-research を自動的に起動します。パッケージ同梱の readme
（`agent-skill/pi-research/README.md`）と
`agent-skill/pi-research/references/configuration.md` には、スキルを直接読む人のために
同じ詳細がまとめられています。

## SDK {#sdk}

スクリプト・CI・カスタムツール向けの高レベルなリサーチ SDK です。設定（レイヤーモデル、
TUI 設定、すべての環境変数）については[設定](#configuration)を参照してください。

### インストール

import が解決するように、プロジェクトの依存としてインストールしてください — すでに
`pi` 拡張機能を実行していても同様です。拡張機能が保持しているのは自分用のプライベートな
コピーで、スクリプトからは import できないためです。

```bash
npm install @lincoln504/pi-research
```

npm ≥11.19（および npm 12）では、依存パッケージのインストールスクリプトはデフォルトで
スキップされます。ここで必要なものはありません。better-sqlite3 13 はサポート対象のすべての
プラットフォーム向けにプリビルド済みバイナリを同梱しており、実行時に読み込みます。
ステルスブラウザも初回使用時にセルフプロビジョニングします。（旧バージョンのドキュメントに
あった `npm approve-scripts better-sqlite3` + `npm rebuild` の組み合わせは
better-sqlite3 12 を修復するためのものです。12 はインストールスクリプトでバイナリを
ダウンロードしていました。13 はバイナリをパッケージに同梱しており、しかも npm 12.0.2 では
approve してもスキップされたスクリプトを実行できません。）

次にモデルを選びます。`initResearchSDK` に `model` を渡すか、`PI_RESEARCH_MODEL`
（環境変数または `~/.pi/research/config.env`）を設定します。SDK は pi 拡張機能内で選択された
モデルに決して追従しません。どちらも未設定の場合にのみ、pi のレジストリにある最初の利用可能な
モデルへフォールバックします。API キーは pi の設定（`~/.pi/agent/auth.json`）から自動的に
取得されるか、`apiKey` オプション / `PI_RESEARCH_API_KEY` 環境変数から取得されます。

`src/sdk.ts` はスクリプト・CI・カスタムツール向けのライブラリです。グローバルなオーバーレイ
ファイルからではなく、コードから設定します — `sdk.env` というものは存在しません。
ベースファイル `~/.pi/research/config.env` を基準として読み込み、すべては `options.config`
で上書きできます。`ignoreGlobalConfig: true` を渡すとグローバルファイルを完全に無視し、
デフォルト値 + `process.env` + `options.config` だけで動作します — コードだけで完結し、
再現可能です。

> ランタイム要件。パッケージのエクスポート（`.` と `/sdk`）は TypeScript のソースコードに
> 解決されます — トランスパイル済みの `dist/sdk.js` は存在しません。型の*除去*だけではなく
> TypeScript を*変換*できるランタイムで実行する必要があります。ソースコードは `enum` と
> コンストラクタパラメータプロパティを使っており、Node の型除去のみのモード
> （`--experimental-strip-types`、Node 23.6 以降のデフォルト）は
> `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` で拒否します。次のいずれかを使ってください:
> - pi ホスト（`jiti` 経由でネイティブに読み込みます）
> - `tsx` や `ts-node` のようなローダー
>
> **素の Node はどのフラグを使ってもロードできません。** Node は `node_modules` 配下にある
> TypeScript — インストール済み依存のソースコードがまさにそれです — の型除去も変換も
> 拒否し、`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` で失敗します。これは
> `--experimental-transform-types` でも `--experimental-strip-types` でも同じなので、
> どのフラグも役に立ちません。ローダー（または pi ホスト）が必須です。
> （`engines.node` は `>=22.19.0` です。）

```typescript
import {
  initResearchSDK,
  runDeepResearch,
  runQuickResearch,
  getResearchReports,
  shutdownResearchSDK,
} from '@lincoln504/pi-research';

// 1. 初期化（設定はすべてコード内で完結。グローバル設定は不要）
await initResearchSDK({
  model: 'openrouter/deepseek/deepseek-v4-flash', // "provider/id" 文字列または Model オブジェクト
  ignoreGlobalConfig: true,                       // 閉じた実行: ~/.pi/research/config.env を無視
  config: { MAX_SCRAPE_BATCHES: 4 },              // 型付きの Config オーバーライド
});

// 2. ディープリサーチ（深度 1–3）
const markdown = await runDeepResearch('全固体電池技術', { depth: 2 });

// 3. クイックリサーチ（深度 0）
const quick = await runQuickResearch('フランスの首都はどこですか');

// 4. 直近の実行におけるリサーチャーごとのレポートを取得
const reports = await getResearchReports();

// 5. クリーンアップ — 必須: 書き込みキューのフラッシュ、LanceDB のクローズ、ワーカーの終了
await shutdownResearchSDK();
```

`initResearchSDK` は、他のリサーチ呼び出しに先立って実行する必要があります。認証は
`options.apiKey` + `options.provider` → `process.env.PI_RESEARCH_API_KEY` /
`PI_RESEARCH_PROVIDER` → pi の `~/.pi/agent/auth.json` の順に解決されます。上記の 5 つの
呼び出しが通常の経路です。[API リファレンス](#api-リファレンス)に、すべてのエクスポートの
シグネチャが一覧されています。

> 同時実行: 初期化済みの 1 つの SDK インスタンスは、一度に 1 つのリサーチ呼び出ししか実行
> できません。同一インスタンス上で重なり合う `runDeepResearch`/`runQuickResearch` 呼び出しは
> 例外をスローします — 逐次実行するか、同時実行ごとに別プロセスを起動してください。
>
> 別プロセス間でも、**マシン単位の同時実行上限**
> （`PI_RESEARCH_MAX_CONCURRENT_RUNS`、デフォルト 3）が適用されます。ホスト上のすべての
> pi-research プロセスがリーダー選出で選ばれた単一のブラウザ/埋め込みプールを共有するため
> です。上限を超えた実行はキューに入り、`PI_RESEARCH_RUN_ACQUIRE_TIMEOUT_MS`（デフォルト
> 10 分）まで待機した後、初めて `ResearchRunCapacityError` で拒否されます — これは
> 「しばらく待って再試行」の Temporary な状態で、CLI は終了コード `75` で表現します。
> `onRunQueued(slots, maxWaitMs)` オブザーバーを渡せば、待機中のユーザーに「実行が
> キューに入っている（ハングしていない）」ことを伝えられます。

### キャンセル

`runDeepResearch`、`runQuickResearch`、`verifyUrl`、`scrapeUrl` は、すべてオプションの
`AbortSignal` を**最後の位置引数**として受け取ります（オプションオブジェクトのフィールドでは
ありません）:

```js
const controller = new AbortController();
setTimeout(() => controller.abort(), 60_000);

const markdown = await runDeepResearch('…', { depth: 2 }, controller.signal);
```

オーケストレーターはラウンドの境界ごとにシグナルをチェックし、検索・スクレイプ・LLM 呼び出し
へ伝播させるため、キャンセルは作業を切り離すだけでなく、実際に停止させます。

**キャンセルが必ず reject するとは限りません。** 結果は、シグナルが届いた時点で何かを
収集済みかどうかで決まります。

| キャンセル時の状態 | 結果 | オブザーバー |
|---|---|---|
| リサーチャーのレポートが 1 件以上収集済み | 収集済みの内容から部分合成を構築して **resolve** | `onComplete` |
| まだ何も収集していない | **reject**（`Research aborted` / `Research cancelled`） | `onError` |

したがって、呼び出し側が自分で実行をキャンセルした場合は、「resolve = 最後まで完走」とは
解釈してはいけません — promise だけでなく、自分のシグナルを確認してください。どちらの場合でも
`onComplete` / `onError` のどちらか片方だけが必ず発火します。

CLI はキャンセルを常に終了コードで報告します。シグナルによる終了はキャンセル帯 —
**`128 + シグナル`**（`130` は Ctrl-C/SIGINT、`143` は SIGTERM、`129` は SIGHUP、`131` は
SIGQUIT）— で終了し、シグナルを伴わないプログラム的なキャンセルは `130` で終了します。
キャンセルされた実行が `0` で終了することは決してありません。`0` はリサーチ成功を意味し、
それを中継したエージェントがユーザーに「完了した実行」として報告してしまうためです。

*部分的な*レポートが先に stdout に出るかどうかは、キャンセルが到着するまでに実行がどこまで
進んでいたかに依存します。ハンドラは Teardown の前に実行中のリサーチをキャンセルするため、
収集済みの内容をまだ合成できるオーケストレーターは、終了前にその材料を出力することが
あります。これはベストエフォートのおまけとして扱ってください — 信頼できるのは終了コードです。

終了コード ≥ 128 はすべてキャンセルとして扱います。`pi-research --help` に全一覧があり、
エージェント向けの契約は
[`SKILL.md`](../agent-skill/pi-research/SKILL.md) の終了コード表です。

これらのコードは意図的にランタイムエラーの `70` ではなく、`retryable: true` も決して
付けません — キャンセルは完了した意図であり、再試行すべき障害ではないからです。コードを
固定値ではなくシグナルから導出するのは、CLI がそれらのシグナルによって*死ぬのではなく処理
する*ためです。固定値にすると、観測される終了ステータスがハンドラが force-kill に勝ったか
どうかに依存してしまいますが、`128 + N` ならどちらの場合でもシェルが報告する値と一致します。

それでも `shutdownResearchSDK()` は事後に呼び出す必要があります。実行のキャンセルが解放する
のはその実行だけであり、ブラウザプール、LanceDB のハンドル、ワーカープロセスは解放されません。

SDK はレポートファイルを書き出しません。レポートのエクスポートはフロントエンドの責務です —
pi 拡張機能と CLI / エージェントスキルが `PI_RESEARCH_REPORT_EXPORT_ENABLED=true` のときに
実行します。

### API リファレンス {#api-リファレンス}

*sdk サブパス専用* と示した 2 つを除き、以下はすべて `@lincoln504/pi-research` と
`@lincoln504/pi-research/sdk` の両方からエクスポートされます — パッケージのエントリ
ポイントはこの 2 つを意図的に再公開していません。`repairJson` と `getSDKContainer` を除く
すべての呼び出しは、先に `initResearchSDK()` を実行することを要求し、未初期化の場合は
`SDK not initialized` をスローします。

**ライフサイクル**

| エクスポート | シグネチャ | 備考 |
|---|---|---|
| `initResearchSDK` | `(options?: ResearchSDKOptions) => Promise<void>` | サービスを登録します。初期化済みなら何もしません。進行中のシャットダウンの完了を待ちます。 |
| `shutdownResearchSDK` | `() => Promise<void>` | 必須。書き込みキューをフラッシュし、LanceDB を閉じ、ワーカープロセスを終了します。すべての `getLast*` アクセサをクリアします。 |
| `getSDKContainer` | `() => ServiceContainer \| null` | *sdk サブパス専用。* 内部/テスト用のサーフェス — 稼働中のサービスコンテナ、init 前は `null`。semver の対象外。パッケージのエントリポイントからはエクスポートされません。 |

**リサーチ**

| エクスポート | シグネチャ | 備考 |
|---|---|---|
| `runDeepResearch` | `(query, options?, signal?) => Promise<string>` | 深度 1–3。Markdown レポートを返します。`options` は `ResearchOptions` から SDK が所有するフィールド（`ctx`、`query`、`model`、`sessionId`、`researchId`）を除いたものです。 |
| `runQuickResearch` | `(query, options?, signal?) => Promise<string>` | 深度 0。上と同じですが `depth` が固定されており、そのため受け付けません。 |
| `runResearchDetailed` | `(query, options?, signal?) => Promise<ResearchRunResult>` | `runDeepResearch` と同じ実行を、素の文字列の代わりに `{ report, sessionId, runId, metrics, stats, reports }` を返して行います。 |
| `getResearchReports` | `(researchId?) => Promise<Map<string, string>>` | リサーチャー id をキーとしたリサーチャーごとのレポート。デフォルトは直近の実行。まだ実行がなければ空のマップです。 |

**ウェブアクセス**

| エクスポート | シグネチャ | 備考 |
|---|---|---|
| `scrapeUrl` | `(url, signal?) => Promise<ScrapeResult>` | 1 つの URL をパイプライン全体に通します（SSRF フィルタ → fetch またはステルスブラウザ → PDF 抽出 → Markdown）。 |
| `verifyUrl` | `(url, signal?) => Promise<boolean>` | 到達性のみを確認し、内容は返しません。URL がブロックされている・死んでいる場合はスローではなく `false` を解決します。 |

**ナレッジストア**

| エクスポート | シグネチャ | 備考 |
|---|---|---|
| `searchKnowledge` | `(queries: string[], signal?) => Promise<KnowledgeSearchResult>` | `{ text, found: 'yes' \| 'maybe' \| 'no', documentsSearched, citations }`。ストアが無効・空・利用不可のときはスローではなく `found: 'no'` を解決します。 |
| `exportKnowledge` | `(outputPath: string) => Promise<void>` | ストアを Web で消費可能な JSON ファイルに書き出します。 |

**実行後テレメトリ** — すべて直近の完了した実行を反映し、完了までは `null`、
`shutdownResearchSDK()` でクリアされます。

| エクスポート | シグネチャ | 備考 |
|---|---|---|
| `getLastRunStats` | `() => ResearchStats \| null` | 実行スナップショットから導出された主要な数値（検索数、スクレイプ数、トークン、コスト）。 |
| `getLastRunMetrics` | `() => IMetricsSnapshot \| null` | その実行の生のカウンタ/ゲージ/ヒストグラム。 |
| `getLastRunSummary` | `() => RunSummary \| null` | `{ runId, startedAt, completedAt, durationMs, status, snapshot }`。 |
| `getLastErrorReport` | `() => ErrorReport \| null` | 集約されたエラー — 総数、パターン、ドメイン別、タイプ別。無人実行の呼び出し側がログを解析せずに失敗状況を確認できます。 |
| `getLastResearcherOutcome` | `() => ResearcherOutcome \| null` | `{ planned, launched, succeeded, failed, failureReasons }`。トピックがスパースで薄いレポートになったのか、リサーチャーの多くが失敗したのかを区別します。 |
| `getSessionMetrics` | `() => IMetricsSnapshot` | 実行ごとではなく、init 以降の全実行の累積値。 |
| `logRunErrorSummary` | `(report, depthLabel, status) => void` | *sdk サブパス専用。* 実行の追跡済みエラーについて、シークレットを含まないコンパクトな 1 行を出力します。レポートが null または空なら何もしません。 |

**状態とユーティリティ**

| エクスポート | シグネチャ | 備考 |
|---|---|---|
| `getResearchHealth` | `(opts?: { force?: boolean }) => Promise<HealthReport>` | 登録済みのすべてのヘルスチェックを実行します。`force` でキャッシュ済みの結果をバイパスします。 |
| `repairJson` | `(json: string) => string` | モデルの出力した切断・破損 JSON を修復します。純粋関数。init 前でも使用可能。 |

**型** — `ResearchSDKOptions`、`ResearchRunResult`、`KnowledgeSearchResult`、
`ResearcherOutcome`、`ResearchOptions`、`ResearchObserver`、`IMetricsSnapshot`、
`IMetricHistogram`、`RunSummary`、`ResearchStats`。

**パッケージのエントリポイントには**さらに、SDK ラッパーを介さずオーケストレーターを直接
使いたい人のために、以下もエクスポートされています: `DeepResearchOrchestrator`、
`QuickResearchOrchestrator`、`HeadlessObserver`（進行状況を stdout に出力するオブザーバー）、
`ServiceNames`、`shutdownManager`、`extractRunStats`、`normalizeUrl`、設定アクセサ
`getConfig` / `setConfig` / `resetConfig` / `validateConfig`、およびチームサイズの定数群。
これらは上記の SDK 関数よりも低レベルで、サービスコンテナを自分で管理することを前提とします。

### init オプション

| オプション | 説明 |
|--------|-------------|
| `model` | `"provider/id"` 文字列または `Model` オブジェクト。省略すると設定済みの `PI_RESEARCH_MODEL` を使用し、それもなければ pi の最初の利用可能なモデルへフォールバックします。 |
| `apiKey` / `provider` | 明示的なクレデンシャル（`apiKey` を渡す場合は `provider` も必須）。 |
| `config` | `Partial<Config>` オーバーライド。ベース/デフォルト値の上に適用されます。 |
| `ignoreGlobalConfig` | `config.env` を完全にスキップ — デフォルト値 + `process.env` + `config` のみ。 |
| `cwd` | ログとナレッジストアの作業ディレクトリ。 |
| `verbose` | ログをコンソールにミラーします。 |

設定の優先順位、フロントエンドごとのオーバーレイ、環境変数の完全なリファレンスは
[設定](#configuration)を参照してください。

### ヘルスおよびナレッジストア API

`health` ツール（および SDK の `getResearchHealth()`）は、登録済みのすべてのヘルスチェック —
ブラウザの能力、ブラウザランタイム、ナレッジストア、ステートマネージャー — を実行し、
構造化されたレポートを返します:

```typescript
import { initResearchSDK, getResearchHealth } from '@lincoln504/pi-research/sdk';

await initResearchSDK();                 // 必須 — 未初期化ならスロー
const result = await getResearchHealth();
// { success: boolean, status: 'healthy' | 'degraded' | 'unhealthy', components: [...] }
```

ナレッジストアは内部サービスであり、公開エクスポートではありません。リサーチの実行中に
自動的に蓄積されます。保存された成果は SDK の `searchKnowledge()` または
`research_knowledge_search` ツールで照会してください。ベクトルの次元はモデルに依存し
（自動検出）、保存されるフィールドは `text`、`content`、`vector`、`url`、`metadata`、
`timestamp`、`workspace`、`is_global`、`ingestion_type` です。

### 使用例

[Wall of Shame](https://wallofshame.io) プロジェクト
（[リポジトリ](https://github.com/Lincoln504/wall-of-shame)）は、エージェントパイプラインで
この SDK を使用しています。調査ごとに `initResearchSDK` とリサーチのエントリポイント
（`runQuickResearch` / `runDeepResearch`）を呼び出し、`scrapeUrl`、`verifyUrl`、
`repairJson` の各エクスポートを直接使用します。

## ナレッジストア {#knowledge-store}

ナレッジストアは、過去のリサーチ成果を保存するローカルのベクトルデータベースです。
オプションのキャッシュであり（ストアがなくてもリサーチは動作します）、次の 2 つの異なる
方法で使われます。

- **ナレッジ優先の回答（ガイダンス）。** `research_knowledge_search` ツールは、繰り返しの
  質問や重複する質問に対し、保存済みの結果から直接回答します。エージェントにはライブの
  `research` ツールの*前に*こちらを試すよう促されますが、これはモデルが従うガイダンスで
  あって強制ではなく、`research_knowledge_search` は独立したツールであり、`research` の
  前に立つ門番ではありません。
- **ライブ実行への種まき（自動）。** ライブの `research` 実行がストアから回答をすることは
  ありません。代わりにオーケストレーターが、過去にその目的で役立った URL を各リサーチャー
  に開始地点として引き渡し、ライブで再取得させます。

![ナレッジストアのヒット — ライブ実行なしでキャッシュ済みの回答を返す](https://raw.githubusercontent.com/Lincoln504/pi-research/main/docs/media/03-knowledge-store.gif)

この組み合わせにより、繰り返しの作業がより速く、より安くなります。

### 保存されるもの

ストアはディスク上の [LanceDB](https://lancedb.com) テーブルです。リサーチのラウンドが終わる
たびに、リサーチャーのレポートで引用された URL がキューに入り、バックグラウンドで書き込まれ
ます。各ソースの要約（および利用可能な場合はその完全な取得済み Markdown）はチャンクに分割
され、各チャンクがベクトルに埋め込まれ、行として保存されます。

各行は、埋め込みベクトル、ソース URL（重複排除のために正規化済み）、要約テキストと完全な
内容、タイムスタンプ、スコープフラグを持ちます。コンテンツハッシュにより、再取り込みされた
URL は重複排除されます。変更のないページはスキップされ、変更のあったページは古い行を置き
換えます。ページの完全な Markdown はドキュメントごとに 1 回だけキャッシュされるため、
保存済みの成果は後で再取得せずに再ハイドレーションできます。

書き込みがリサーチの実行をブロックすることは決してありません。書き込みは非同期の書き込み
キューを経由し、ラウンドの終了時とシャットダウン時にフラッシュされます。

### スコープ: none、project、global

ストアの適用範囲はナレッジモード（`PI_RESEARCH_KNOWLEDGE_STORE_MODE`）で決まります。
これはプロジェクトスコープの設定で、ディレクトリごとに変更できます。

| モード | 動作 |
|------|----------|
| `global`（デフォルト） | すべてのディレクトリで単一のストアを共有します。あるプロジェクトで保存した成果は、他のどのプロジェクトからでも取得できます。 |
| `project` | 成果は作成された作業ディレクトリに限定され、そのディレクトリだけが取得できます。 |
| `none` | ストアは無効化されます — 何も読み書きされず、`research_knowledge_search` ツールはエージェントにアナウンスされず、`/knowledge-store` も利用できません。再有効化に再起動は不要です（登録の詳細は [Pi 拡張](#pi-extension) を参照）。 |

現在のディレクトリのモードは、pi 拡張機能の `/research-config` TUI（ナレッジモード）か、
スタンドアロン CLI では `pi-research knowledge-config set <none|project|global>`
（1 つの値のみ選択）で変更します。設定はディレクトリごとのプロジェクトレジストリに保存され
ます。優先順位チェーンの全体は[設定](#configuration)を参照してください。変更は次の実行から
適用されます — 再起動は不要です。

すべてのスコープは単一の物理的な LanceDB ディレクトリを共有します。project 行と global 行は
列で区別され（正規化された workspace パスとグローバルフラグ）、クエリ時点でフィルタされます。
ディレクトリを分けて保存するわけではありません。デフォルトのデータベースディレクトリは
`~/.pi/research/knowledge_db/` です（`PI_RESEARCH_KNOWLEDGE_DIR` で上書き可能）。

埋め込みモデルは遅延初期化です。ストアが実際に初めて書き込まれるか照会されたときにのみ
ダウンロード・初期化されるため、デフォルトの `global` は、実行が最初のページをキャッシュする
までは起動コストを一切追加しません。

### 実行がストアをどう使うか

ストアを駆動するのはオーケストレーターであり、リサーチャーエージェントが随意に呼び出すもの
ではありません。これにより使用が決定的になります。

1. 各リサーチャーが開始する前に、オーケストレーターがそのリサーチャーの目標でストアを検索し、
   一致した過去の URL — それぞれに以前の要約を添えて — を、再取得の開始地点として
   リサーチャーのプロンプトに注入します。
2. ラウンドの後、引用された URL とその説明が書き込みキューに入り、次のセッションのために
   保存されます。

別途、`research_knowledge_search` ツール（および SDK の `searchKnowledge()`）により、モデルは
ストアを直接照会できます。最も関連の高い保存済みドキュメントを再ハイドレーションし、
バックグラウンドの LLM にそれらが質問に答えるかを判定させ、引用付きの合成回答を返すか、
ライブリサーチが必要であることを報告します。

### 埋め込みとモデル

埋め込みは、ONNX 上の
[`@huggingface/transformers`](https://github.com/huggingface/transformers.js) により
ローカルで計算されます。デフォルトのモデルは
`onnx-community/granite-embedding-small-english-r2-ONNX`（英語、チャンク窓 512 トークン）です。
サポートされる各モデルは、独自のチャンクサイズ、プーリング戦略、接頭辞を定義し、固定の
ベクトル次元を生成します。テーブルのスキーマはその次元を基に構築されます。

サポートされるモデル（`PI_RESEARCH_EMBEDDING_MODEL`）:

| モデル | 言語 |
|-------|-----------|
| `onnx-community/granite-embedding-small-english-r2-ONNX`（デフォルト） | 英語 |
| `Xenova/multilingual-e5-small` | 多言語 |
| `Xenova/multilingual-e5-base` | 多言語 |
| `Xenova/bge-m3` | 多言語 |
| `onnx-community/embeddinggemma-300m-ONNX` | 多言語 |
| `onnx-community/Qwen3-Embedding-0.6B-ONNX` | 多言語 |
| `Xenova/all-MiniLM-L6-v2` | 英語 |
| `Xenova/bge-small-en-v1.5` | 英語 |
| `Xenova/all-mpnet-base-v2` | 英語 |

モデルを変更すると既存のベクトルは無効になります（次元も意味も異なるため）。ストアは
移行されます（後述のモデル変更を参照）。モデルは初回使用時に Hugging Face からダウンロード
されてキャッシュされます。初回のダウンロードには数分かかることがあります
（低速回線では `PI_RESEARCH_EMBEDDING_MODEL_INIT_TIMEOUT_MS` を引き上げてください）。

### デバイス選択

埋め込みは GPU（WebGPU。ランタイム組み込みの Dawn バックエンド経由）または CPU で実行され
ます。バックエンドは `PI_RESEARCH_EMBEDDING_DEVICE` で選択します。

- `auto`（デフォルト。TUI では GPU と表示）— pi-research は使い捨ての子プロセスで WebGPU の
  実行可能性をプローブします。そこでモデルをロードし、実際に埋め込みを 1 回実行します。
  成功すれば GPU、失敗すれば CPU を使用します。判定はキャッシュされるため、プローブは
  マシン + モデルの組み合わせごとに最大 1 回しか実行されません。
- `cpu`（TUI では CPU と表示）— プローブなしで CPU 推理を強制します。
- `webgpu` — プローブなしで GPU 経路を強制します。上級 / 環境変数専用。下記参照。

プローブが存在する理由。一部のホスト — VM、コンテナ、CI ランナー、ソフトウェア Vulkan
ドライバを備えたヘッドレスマシン — は、ネイティブバックエンドが計算を実行できない GPU を
露出しています。この障害はネイティブの segfault であり、捕捉可能なエラーではないため、
プロセスを終了させます。`auto` プローブは子プロセスで実行可能性を検証し（子プロセスのクラッシュ
はメインプロセスに影響しません）、CPU にフォールバックします。`webgpu` の強制はこのチェックを
バイパスするため、そのようなホストではクラッシュする可能性があります。そこで
`/research-config` メニューは GPU（= `auto`）と CPU の 2 択のみを提供しています。素の
`webgpu` も環境変数経由で利用可能で、GPU が良好だと分かっているホストでのベンチマークに
使えます。

キャッシュされた判定は `~/.cache/pi-research/webgpu-viability.json` に保存され、プラットフォーム・
アーキテクチャ・Node のメジャーバージョン・モデルでインデックスされます。
`PI_RESEARCH_WEBGPU_REPROBE=1` を設定すると破棄して再プローブします
（ドライバ更新後など）。

### プラットフォーム対応（Intel Mac 非対応）

ストアは 2 つのネイティブコンポーネント — 埋め込み用の ONNX ランタイムとベクトル保存用の
LanceDB — に依存しており、この 2 つは特定のプラットフォーム/アーキテクチャの組み合わせに
のみプリビルド済みバイナリを配布しています。

| プラットフォーム | アーキテクチャ | ナレッジストア |
|----------|--------------|-----------------|
| macOS | Apple Silicon（arm64） | 対応 |
| macOS | Intel（x64） | 利用不可 |
| Linux | x64 / arm64 | 対応 |
| Windows | x64 / arm64 | 対応 |

Intel Mac（`darwin-x64`）にはどちらのコンポーネントのプリビルドバイナリも存在しないため、
ストアは動作できません。同じクリーンな無効化は、必要なパッケージがまったくインストールされて
いない場合にも、どのプラットフォームでも発生します。オプションの
`@huggingface/transformers` が `npm install --omit=optional` でスキップされた場合
（および npm のオプション依存のバグでも）、または `@lancedb/lancedb` のインストールが壊れている
場合です。劣化は自動的かつ迅速です。

- リサーチは動作し続けます。検索、スクレイプ、YouTube 字幕、セキュリティデータベース、
  Stack Exchange、プランニング、合成は影響を受けません — 失われるのはストアだけです。
- ストアはフェイルファストします。欠けているパッケージは初期化の試行前に解決時点で検出される
  ため、リトライストームは発生せず、ストアは OFF のまま起動します。
- 設定サーフェスが理由を説明します。`pi-research knowledge-config`、`/research-config` メニュー、
  ヘルスチェックは、ストアが実現できないモードを宣伝するのではなく、欠けているパッケージと
  修復方法（オプション依存のインストール）を指名します。`research_knowledge_search` の失敗は、
  役に立たない設定スイッチを指すのではなく、パッケージの欠落を報告します。
- ヘルスチェックはストアを「不健全」ではなく「無効」として報告するため、欠けたコンポーネントが
  全体のステータスを "unhealthy" に引きずったり、クイック（深度 0）実行をブロックしたりしません。

設定は不要です。パッケージをインストールし（オプション依存を含むフルインストール）、ストアは
立ち上がります。モードの切り替えだけでは、プロセスの途中でストアを復活させることはできません。

### 保持と排出

キャッシュされた成果は `PI_RESEARCH_CACHE_TTL_DAYS`（デフォルト 30、範囲 1–365）の間保持
されます。排出はストアのオープン時にチェックされ、現在のスコープ内のしきい値より古い行だけを
削除します。値を下げればより新鮮なデータと少ないディスク消費、上げればより長い履歴保持に
なります。

### モデル変更: 移行

設定された埋め込みモデルが、保存済みベクトルの構築に使われたモデルと異なる場合、ストアは
`PI_RESEARCH_MIGRATION_STRATEGY` に従って移行します。

| 戦略 | 何が起こるか |
|----------|--------------|
| `backup`（デフォルト） | 旧テーブルを脇にリネームし（`knowledge_backup_<timestamp>.lance`）、新モデル用の新しいテーブルを作成します。旧データはディスクに残りますが検索対象にはなりません。 |
| `drop` | 旧テーブルを破棄し、新しいテーブルを作成します。高速。バックアップなし。 |
| `re-embed` | 保存済みの各ドキュメントを新モデルで再埋め込みし、新しいテーブルに保存します。履歴を保持します。最も遅い。 |

`re-embed` が失敗すると、pi-research は `backup` にフォールバックします。`backup`
（または `drop`）の失敗は移行をその場で中断させます。ストアは旧モデルのまま残り、次回の
オープン時に再試行されます — 明示的に `drop` を選ばない限り、データが破棄されることは
ありません。`/research-config` メニューからのモデル変更は、現在のストアを消去してゼロから
始める前に確認を求めます。拒否すればモデル変更は取り消され、ストアはそのまま残ります。

### ストアの管理

`/research-config` から:

- ストアの状態 — エントリ数（プロジェクトとユーザー）、現在有効な埋め込みモデルとデバイス、
  ディスク上のパス。
- プロジェクトストアの消去 / ユーザーストアの消去 — project スコープまたは global スコープの行を
  完全に削除します（現在のモードに応じて表示）。
- ヘルスチェックの実行 — ブラウザプール、GPU/埋め込み、ストアの接続性を検証し、ストアの
  正常性を報告します。

ストアはコピーオンライトで増えていきます（実行ごとにバージョンを 1 つ追加）。保存データを
変更した実行の後には自動的にコンパクションされ、古いバージョンとインデックスが剪定されて
サイズが有界に保たれます。手動のメンテナンスコマンドは存在しません。

### 設定

| 設定 | 変数 | デフォルト |
|---------|----------|---------|
| ナレッジモード（プロジェクトスコープ） | `PI_RESEARCH_KNOWLEDGE_STORE_MODE` | `global` |
| 埋め込みモデル | `PI_RESEARCH_EMBEDDING_MODEL` | `onnx-community/granite-embedding-small-english-r2-ONNX` |
| 埋め込みデバイス | `PI_RESEARCH_EMBEDDING_DEVICE` | `auto` |
| キャッシュ保持（日） | `PI_RESEARCH_CACHE_TTL_DAYS` | `30` |
| 移行戦略 | `PI_RESEARCH_MIGRATION_STRATEGY` | `backup` |
| データベースディレクトリ | `PI_RESEARCH_KNOWLEDGE_DIR` | `~/.pi/research/knowledge_db` |
| モデル初期化タイムアウト（ms） | `PI_RESEARCH_EMBEDDING_MODEL_INIT_TIMEOUT_MS` | `300000` |
| WebGPU 再プローブ | `PI_RESEARCH_WEBGPU_REPROBE` | _（未設定）_ |

設定モデルの全体は[設定](#configuration)を、ストアがエンジン内でどう位置づけられているかは
[アーキテクチャ](#architecture)を参照してください。

## 設定 {#configuration}

すべてのフロントエンド（pi 拡張機能、スキル対応ホストが実行するスタンドアロン CLI /
エージェントスキル、SDK）は、単一の設定モデルを共有します。このドキュメントでは、まず
`/research-config` TUI に露出している設定を説明し、次に環境変数の完全なリファレンス、最後に
設定レイヤーの解決方法を説明します。

![/research-config 設定 TUI](https://raw.githubusercontent.com/Lincoln504/pi-research/main/docs/media/04-config.gif)

### TUI の設定

pi 拡張機能で `/research-config` を実行すると、対話型メニューが開きます。設定を選んで
`Enter` / `Space` を押すと値が順送りされ、変更は即座に保存されます。（TUI のないホスト —
RPC、web hub、print、JSON、SDK — ではメニューを表示できません。`/research-config` はその
理由を説明し、それらのホストで動作するヘッドレス診断
`/research-config health` と `/research-config knowledge-status` で応答します。こうしたホストでも
設定は環境変数と設定ファイルから読み込まれ、`PI_RESEARCH_*` 変数は通常どおり機能します。）
設定は 2 つのスコープのどちらかに書き込まれます。

- `[project]` — 作業ディレクトリごとに中央のプロジェクトレジストリへ保存されます。リポジトリが
  グローバル値を変えずに自分専用の値を持てます。
- ユーザー — 共有ベースファイル（`config.env`）へ保存されます。上位のレイヤーが上書きしない
  限り、すべてのディレクトリとフロントエンドに適用されます。

| 設定 | スコープ | 値 | 変数 |
|---------|-------|--------|---------|
| `/research` の深度 | プロジェクト | normal · deep · ultra | `PI_RESEARCH_DEFAULT_RESEARCH_DEPTH` |
| ナレッジモード | プロジェクト | none · project · global | `PI_RESEARCH_KNOWLEDGE_STORE_MODE` |
| リサーチャータイムアウト | ユーザー | 3 · 5 · 10 · 15 · 20 · 30（分） | `PI_RESEARCH_TIMEOUT_MS` |
| 最大並列数 | ユーザー | 1 – 5 | `PI_RESEARCH_MAX_RESEARCHERS` |
| スクレイプバッチ数 | ユーザー | unlimited · 1 · 2 · 3 · 5 · 10 · 15 | `PI_RESEARCH_MAX_SCRAPE_BATCHES` |
| レポートの自動エクスポート | ユーザー | true · false | `PI_RESEARCH_REPORT_EXPORT_ENABLED` |
| 埋め込みモデル | ユーザー | サポートされるモデルのいずれか | `PI_RESEARCH_EMBEDDING_MODEL` |
| 埋め込みデバイス | ユーザー | GPU · CPU | `PI_RESEARCH_EMBEDDING_DEVICE` |
| キャッシュ保持 | ユーザー | 7 · 14 · 30 · 60 · 90 · 180 · 365（日） | `PI_RESEARCH_CACHE_TTL_DAYS` |
| デバッグログ | ユーザー | true · false | `PI_RESEARCH_DEBUG` |

埋め込みデバイスはメニューで 2 択です。GPU は自動検出経路に対応し、pi-research は WebGPU が
このマシンで本当に動くかをプローブし、動かなければ CPU にフォールバックします。CPU は CPU
のみの推論を強制します。生の強制 GPU（プローブなし）には、ベンチマーク用に環境変数
`PI_RESEARCH_EMBEDDING_DEVICE=webgpu` でしか届きません —
[ナレッジストアのドキュメント](#knowledge-store)を参照してください。

埋め込みモデル・埋め込みデバイス・キャッシュ保持の行は、ナレッジモードが `none` でないときに
のみ表示されます。

メニューには設定以外のアクションもあります。ヘルスチェックの実行、ストアの状態、プロジェクト /
ユーザーストアの消去、セッションメトリクス、デバッグログの消去、そして外部エージェントへの
インストール / 削除（コーディングエージェントスキルインストーラー）です。ブラウザのワーカー数は
意図的にメニューの外にあります — CPU/RAM に敏感であり、`PI_RESEARCH_WORKER_THREADS`
のみで設定します。

### 環境変数

すべての設定は、同時に環境変数でもあります。リポジトリの
[`.env.example`](https://github.com/Lincoln504/pi-research/blob/main/.env.example) が、インライン
コメント付きの権威ある完全なリストです。このセクションでは同じ変数群を、デフォルト値と有効な
範囲とともにカテゴリ別に示します。範囲外の数値は（警告付きで）クランプされ、無効な列挙値は
（警告付きで）デフォルトにフォールバックします。

TUI に露出している変数には `(TUI)` が付きます。`[project]` の印はプロジェクトスコープのキー
（ディレクトリごとにレジストリへ保存）を示し、その他はすべてユーザースコープです。

リサーチ

| 変数 | デフォルト | 範囲 | 説明 |
|----------|---------|-------|-------------|
| `PI_RESEARCH_TIMEOUT_MS`（TUI） | `300000` | 180000–1800000 | リサーチャーごとのタイムアウト（3–30 分）。 |
| `PI_RESEARCH_MAX_RESEARCHERS`（TUI） | `3` | 1–5 | 並列で動くリサーチャーの数。 |
| `PI_RESEARCH_DEFAULT_RESEARCH_DEPTH`（TUI）`[project]` | `1` | 1–3 | `--depth` を省略したときの `/research` と CLI の深度（1=normal、2=deep、3=ultra）。 |
| `PI_RESEARCH_MAX_SCRAPE_BATCHES`（TUI） | `2` | 0–99 | リサーチャーごとのスクレイプバッチ数（0 = 無制限）。解決済みリサーチモデルでプロンプトキャッシュが有効だと分かっている場合（Anthropic API モデル、または Anthropic 風キャッシュ制御を明示設定した経路）は、実効上限はこの値 + 1 です — キャッシュ済みのプロンプト接頭辞によって追加バッチが安くなるためです。 |
| `PI_RESEARCH_MAX_GATHERING_CALLS` | `12` | 1–100 | リサーチャーごとの共有ウェブ収集呼び出し数（`search` + `security_search` + `stackexchange` + `youtube_transcript`）。 |
| `PI_RESEARCH_MAX_CONCURRENT_SCRAPES` | `3` | 1–20 | スクレイプバッチごとに並列取得する URL 数。 |
| `PI_RESEARCH_MAX_SCRAPE_URLS` | `8` | 1–20 | スクレイプバッチごとに取得する URL の上限。上限を超えた URL は "Not Fetched — Over Batch Cap" の下に列挙され、後続のバッチで要求する必要があります。（他のスクレイプノブと同様に、環境/設定ファイルで調整できるよう、固定定数から昇格しました。） |
| `PI_RESEARCH_SCRAPE_SECOND_PAGE` | `false` | true/false | 各検索クエリで DuckDuckGo の検索結果 2 ページ目も取得し、クエリが供給する候補リンクを約 2 倍にします。2 ページ目は優雅に劣化します — 取得に失敗しても存在しなくても、1 ページ目の結果はそのまま保持されます。 |
| `PI_RESEARCH_MAX_RETRIES` | `2` | 0–5 | リサーチャー要求ごとの再試行数。 |
| `PI_RESEARCH_RETRY_DELAY_MS` | `2000` | 100–10000 | 再試行間の基本遅延。 |
| `PI_RESEARCH_MAX_FAILED_RESEARCHERS` | `2` | 1–10 | 実行全体を中止させる、リサーチャー失敗の重複なしカウント。遅くまだ実行中のリサーチャーが終わるのを待ってから諦めるように、値を上げられます。 |
| `PI_RESEARCH_WORKER_THREADS` | `4` | 1–10 | ブラウザワーカーのプロセス数。多いほどスループットが上がり、CPU/RAM も増えます。これは検索バーストを*どれだけ速く*捌くかを決めるものであり、*どれだけ大きく*できるかではありません — プールより大きいバーストは、切り捨てられたりタイムアウトしたりするのではなく、順番を待ちます。 |
| `PI_RESEARCH_WORKER_CONCURRENCY` | `2` | 1–10 | ワーカープロセスごとのタスク数。 |
| `PI_RESEARCH_MAX_CONCURRENT_RUNS` | `3` | ≥1 | マシン単位の同時リサーチ実行上限で、**すべての**プロセス（CLI、エージェントスキル、pi 拡張機能、SDK）に適用されます。上限を超えた実行は失敗ではなくキューに入ります。同時実行はすべてリーダー選出で選ばれた単一のブラウザ/埋め込みプールを共有するため、過剰に購読するとすべてが同時に劣化します。 |
| `PI_RESEARCH_RUN_ACQUIRE_TIMEOUT_MS` | `600000` | ≥0 | キューに入った実行が、"maximum concurrent research runs reached" で失敗するまで（CLI 終了コード `75`）に空きスロットを待つ時間。`0` = キューに入らず即座に失敗。 |
| `PI_RESEARCH_MODEL` | _（pi: セッションモデル。CLI/スキル: 必須）_ | — | リサーチを実行するモデル。**スタンドアロン CLI / エージェントスキルでは必須** — この設定済みモデルのみを使用し（pi 拡張機能内で選択されたモデルには決して追従しません）、なければ起動を拒否します（CLI の実行ごとの `--model` フラグでも要件を満たせます）。SDK では、`model` オプションが未指定のときのセッションモデルを選びます。pi 拡張機能では、リサーチャーのサブエージェントとナレッジ合成をオーバーライドし、コーディネーターとリサーチリードは引き続きセッションモデルを使用します。`provider/id` または素のモデル id を受け付けます。 |
| `PI_RESEARCH_DISABLED_TOOLS` | _（なし）_ | — | 実行中に無効化する、カンマ区切りのリサーチツール（`search`、`scrape`、`security_search`、`stackexchange`、`youtube_transcript`、`grep`、`read`）。各リサーチャーのツールセットから取り除かれ、コーディネーターとリサーチリードのプロンプトで名指しされます。厳密に加法的 — 能力を奪うことだけができ、決して付与できず、デフォルトの除外を置き換えるのではなくその上に積み重なります。認識できない名前は何も除外せず、実行を失敗させる代わりに警告を出します。 |
| `PI_RESEARCH_REPORT_EXPORT_ENABLED`（TUI） | `false` | — | フロントエンドが Markdown レポートをディスクに書き出し、パスを表示します。 |
| `PI_RESEARCH_REPORT_EXPORT_DIR` | _（賢い cwd）_ | — | エクスポートされたレポートを固定ディレクトリにピン留めし、cwd 相対の解決を回避します。ホストエージェントの任意のディレクトリから実行されるエージェントスキルで特に有用です。 |
| `PI_RESEARCH_MAX_SCRAPE_TOKEN_FRACTION_FOR_SCRAPING` | `0.15` | 0.05–1.0 | 初期スクレイプコンテキストに使うコンテキスト窓の最大割合。 |
| `PI_RESEARCH_AVG_TOKENS_PER_SCRAPE` | `2500` | 500–10000 | スクレイプ結果ごとの推定トークン数。プランニングに使用します。 |

YouTube 字幕

| 変数 | デフォルト | 範囲 | 説明 |
|----------|---------|-------|-------------|
| `PI_RESEARCH_YOUTUBE_TRANSCRIPT_MAX_VIDEOS` | `3` | 1–5 | `youtube_transcript` 呼び出しごとに字幕を取る動画数。 |
| `PI_RESEARCH_YOUTUBE_TRANSCRIPT_TIMEOUT_MS` | `20000` | 5000–120000 | 動画ごとの字幕タイムアウト。 |
| `PI_RESEARCH_YOUTUBE_TRANSCRIPT_LANG` | `en` | — | 優先する字幕言語（BCP-47 接頭辞）。 |
| `PI_RESEARCH_YOUTUBE_QUERY_EVERY_N` | `5` | 1–100 | 約 N 回に 1 回、検索クエリに `youtube` を追加します（1 = すべてのクエリ）。 |
| `PI_RESEARCH_YOUTUBE_POTOKEN_REQUEST_KEY` | _（内蔵）_ | — | 上級: BotGuard PoToken の Web リクエストキーをオーバーライドします（YouTube が公開キーをローテーションし字幕が失敗し始めたときだけ使用）。 |

タイムアウト

| 変数 | デフォルト | 範囲 | 説明 |
|----------|---------|-------|-------------|
| `PI_RESEARCH_LLM_TIMEOUT_MS` | `300000` | 60000–1800000 | コーディネーター / リサーチリード / 修復 / ナレッジの LLM 呼び出しタイムアウト。 |
| `PI_RESEARCH_SCRAPE_TIMEOUT_MS` | `15000` | 5000–120000 | ページごとのスクレイプ（ページロード）タイムアウト。 |
| `PI_RESEARCH_SEARCH_TIMEOUT_MS` | `45000` | 5000–120000 | ブラウザの検索ページタイムアウト。 |
| `PI_RESEARCH_BROWSER_TASK_TIMEOUT_MS` | `10000` | 2000–120000 | 各ブラウザ操作自身のタイムアウトに上乗せする余裕（検索タスクの上限は `SEARCH_TIMEOUT_MS` + この値 + 約 120 秒の固定コールドスタート余裕。スクレイプは `SCRAPE_TIMEOUT_MS` + この値 + 同じ余裕）。コールドスタート余裕はワーカーの初回の実際のブラウザ起動とコンテキスト作成をカバーし、ユーザーが調整することはできません。これらの上限が拘束するのは**実行**です。タスクの時計はワーカーが手に取った時点で始まるため、他の作業の後ろでキュー待ちする時間は課金されず、混雑したプールをカバーするためにこの値を上げることは不要で、効果もありません。 |
| `PI_RESEARCH_HEALTH_CHECK_TIMEOUT_MS` | `10000` | 2000–120000 | 飛行前のヘルスチェックのタイムアウト。 |

LLM 出力と推論

これらは環境変数のみの上級ノブです（TUI にはありません）。

| 変数 | デフォルト | 範囲 | 説明 |
|----------|---------|-------|-------------|
| `PI_RESEARCH_LLM_THINKING_LEVEL` | `off` | off · minimal · low · medium · high | エンジンのすべての LLM 作業（コーディネーター、ルーター、シンセサイザー、JSON 修復、ナレッジ抽出、リサーチャーサブエージェント）の思考連鎖レベル。デフォルトはオフ — これらの呼び出しは構造化 JSON / 引用付きレポートを出すため、思考ブロックは出力予算を消費し、回答を切断しかねません。pi によりモデルごとにクランプされます。 |
| `PI_RESEARCH_PLANNING_MAX_TOKENS` | `16384` | 1024–131072 | コーディネーターのプランの最大出力トークン。ルーターの判定にはより小さな独自の上限があり、最終合成は `PI_RESEARCH_SYNTHESIS_MAX_TOKENS` を使用します。モデルの実際の上限にクランプされます。 |
| `PI_RESEARCH_SYNTHESIS_MAX_TOKENS` | `32768` | 1024–131072 | 最終合成レポートの最大出力トークン。モデルの実際の上限にクランプされます。 |

ナレッジストア

各値の意味は[ナレッジストアのドキュメント](#knowledge-store)を参照してください。

| 変数 | デフォルト | 範囲 | 説明 |
|----------|---------|-------|-------------|
| `PI_RESEARCH_KNOWLEDGE_STORE_MODE`（TUI）`[project]` | `global` | none · project · global | ストアのスコープ: すべてのディレクトリで共有（`global`）、現在のディレクトリに限定（`project`）、無効化（`none`）。この設定とは無関係に、必要なパッケージがインストールされていないとき（オプションの `@huggingface/transformers` がインストール時に省略された、`@lancedb/lancedb` が壊れている）は、ストアはクリーンに OFF になります: init はリトライストームではなくフェイルファストし、`pi-research knowledge-config`、`/research-config` メニュー、ヘルスチェックが欠けているパッケージと修復方法を指名します。 |
| `PI_RESEARCH_EMBEDDING_MODEL`（TUI） | `onnx-community/granite-embedding-small-english-r2-ONNX` | — | 埋め込みモデル。変更するとストアが消去され、ゼロから始まります。 |
| `PI_RESEARCH_EMBEDDING_DEVICE`（TUI） | `auto` | auto · webgpu · cpu | 推論バックエンド。`auto` はプロセス外で WebGPU の実行可能性をプローブし CPU にフォールバックします。`cpu` は CPU を強制します。`webgpu` はプローブなしで GPU 経路を強制します（上級 — ソフトウェア GPU ではハードクラッシュする可能性）。TUI は `auto`（"GPU" と表示）と `cpu` だけを露出します。 |
| `PI_RESEARCH_CACHE_TTL_DAYS`（TUI） | `30` | 1–365 | キャッシュされた成果が排出されるまで保持される期間。 |
| `PI_RESEARCH_KNOWLEDGE_STORE_MAX_SERVE_AGE_DAYS` | `0` | 0–3650 | 読み取り時に、キャッシュ済みの取得を*提供*できる最大の年齢。超えるとミスとして扱われ、新鮮に再取得されます。`0` = 無効（TTL までなら何歳でも提供）。キャッシュの年齢はこの値に関係なく、常にモデルに提示されます。 |
| `PI_RESEARCH_MIGRATION_STRATEGY` | `backup` | drop · backup · re-embed | 埋め込みモデルを変更したときに、保存済みデータをどうするか。 |
| `PI_RESEARCH_KNOWLEDGE_DIR` | _（自動）_ | — | ストアのデータベースディレクトリをオーバーライドします。デフォルト: `~/.pi/research/knowledge_db`。 |
| `PI_RESEARCH_EMBEDDING_MODEL_INIT_TIMEOUT_MS` | `300000` | 10000–600000 | 埋め込みモデルの初期化タイムアウト（初回ダウンロードは遅いことがあります）。 |
| `PI_RESEARCH_WEBGPU_REPROBE` | _（未設定）_ | — | `1` を設定すると、キャッシュされた WebGPU 実行可能性の判定を破棄し、次回使用時に再プローブします。 |

API キー

| 変数 | 説明 |
|----------|-------------|
| `PI_RESEARCH_API_KEY` / `PI_RESEARCH_PROVIDER` | SDK / CLI モード向けの明示的な LLM クレデンシャル（pi の設定がキーを供給する場合は不要）。CLI / エージェントスキルでは、両方とも `config.env` / `cli.env` に置くこともできます。provider はキーと一緒に必須で、`provider/model-id` 形式の `PI_RESEARCH_MODEL` から推論されることもあります。注意: プロバイダーのネイティブ変数（`OPENAI_API_KEY`、`ANTHROPIC_API_KEY` など）は、**実環境変数**としてのみ認識されます — `config.env` / `cli.env` に置いても効果はありません（これらのファイルがブリッジするのは `PI_RESEARCH_*` キーと `STACKEXCHANGE_API_KEY` / `GITHUB_TOKEN` / `NVD_API_KEY` だけです）。 |
| `STACKEXCHANGE_API_KEY` | Stack Exchange ツールのレート制限を 300/日から 10 000/日へ引き上げます。<https://stackapps.com/apps/oauth> で取得してください。 |
| `GITHUB_TOKEN` | セキュリティツールの GitHub アドザイサリのレート制限を 60/時間から 5000/時間へ引き上げます（任意のデフォルトスコープのトークン）。 |
| `NVD_API_KEY` | セキュリティツールの NVD レート制限を約 10 倍に引き上げ、リクエスト間隔を締めます。<https://nvd.nist.gov/developers/request-an-api-key> で申請してください。重要度でフィルタしたセキュリティ検索を使う場合に推奨: そのような検索は v2 のみの CVE を捕まえるための 2 回目の（CVSS v2）NVD クエリを発行し、未認証の 6 秒/リクエスト制限に対するリクエスト時間をほぼ倍増させます。 |

診断とプラットフォーム

| 変数 | デフォルト | 説明 |
|----------|---------|-------------|
| `PI_RESEARCH_DEBUG`（TUI） | `false` | ログファイルへの INFO+DEBUG の詳細ログ。注意: `config.env` に保存された `DEBUG=true` 行は、設定の*保存*が行われたプロセスでのみ確実に効きます（保存は環境へ同期しますが、単なるロードはしません）— プロセスの起動時から確実に詳細ログを得るには、環境に `PI_RESEARCH_DEBUG=true` をエクスポートしてください。 |
| `PI_RESEARCH_CONSOLE_LOG` | `false` | ログを stdout/stderr にミラーします（CI / ヘッドレスで有用）。 |
| `PI_RESEARCH_LOG_PATH` | _（OS の一時ディレクトリ）_ | 詳細ログファイルのパスをオーバーライドします。ブラウザワーカーは自動的に継承します。 |
| `PI_RESEARCH_LOG_FILE` | _（未設定）_ | ブラウザワーカースレッドのログを別ファイルへ送ります。未設定のときはワーカーは `PI_RESEARCH_LOG_PATH` に記録します。 |
| `PI_RESEARCH_TMP_DIR` | `~/.cache/pi-research/profiles` | ワーカーごとの一時ブラウザプロファイルディレクトリ。デフォルトではディスクに置かれます（RAM 上の `/tmp` の外に保ち、ワーカーのプロファイルがメモリ圧力を追加しないようにします）。システムの一時ディレクトリ配下を指せば tmpfs/RAM を選べます。 |
| `PI_RESEARCH_STATE_DIR` | `~/.pi/research/state` | 状態ディレクトリ（アクティブセッション、ブラウザ状態、プロジェクトレジストリ）をオーバーライドします。 |
| `PI_RESEARCH_TUI_REFRESH_DEBOUNCE_MS` | `100` | TUI リフレッシュのデバウンス（0–1000 ms）。 |
| `PI_RESEARCH_SKIP_HEALTHCHECK` | _（未設定）_ | `1`/`true` を設定すると、飛行前のブラウザ/埋め込みヘルスチェックをスキップし、タスクごとのタイムアウトに依存します。**深度 0（クイック）専用** — 深度 1–3 の実行にはその種の飛行前チェックがないため、これらに対しては効果がありません。 |
| `PI_RESEARCH_PDF_WORKER` | _（未設定）_ | `off` を設定すると、PDF 解析をメインスレッドで強制実行します（1.6.6 以前の動作）。ワーカースレッドへのオフロードを回避します。ワーカーやパッケージングの問題向けの緊急スイッチ。デフォルトでは、そのバンドルが存在すればワーカー内で解析します。 |
| `PI_RESEARCH_USE_XVFB` | _（未設定）_ | Linux のみ。素の TTY での実行は真にヘッドレスであり、X サーバーは不要です。`true` を設定すると仮想フレームバッファを選択します（`sudo apt install xvfb`）。 |
| `PI_RESEARCH_SKILL_DIR` | _（自動）_ | 同梱のリサーチスキルのソースディレクトリをオーバーライドします。スキルインストーラーが使用します。 |
| `PI_RESEARCH_PURGE_BROWSERS` | _（未設定）_ | 同梱の `scripts/cleanup.cjs` が読み取ります: `1` を設定すると、共有の camoufox ブラウザキャッシュも削除します（他のインストールが使用している可能性があるため、デフォルトでは保持されます）。注意: npm ≥7 は `preuninstall` を実行しないため、このスクリプトは `npm uninstall` では発火しません — [エージェントスキル](#agent-skill)を参照してください。 |
| `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD` | _（未設定）_ | `npm install` 中に `1` を設定すると、camoufox ブラウザのダウンロードをスキップします（初回使用時に遅延取得されるようになります。Playwright の標準的な慣習）。 |
| `CAMOUFOX_INSTALL_DIR` | _（ユーザーキャッシュ）_ | camoufox-js 自身の変数であり、ブラウザを再配置できる唯一の変数です。pi-research がバイナリを探す場所を決め、postinstall の取得とブラウザワーカーへエクスポートされます。固定されている camoufox-js 0.12.0+ では有効で、この変数を再び尊重します。古い固定バージョン（<0.12。キャッシュディレクトリをコード内にハードコード）では検索だけを再配置しました — [アーキテクチャ](#architecture)を参照してください。 |
| `PLAYWRIGHT_BROWSERS_PATH` | _（ユーザーキャッシュ）_ | 前述の変数のエイリアス。互換性のために受け付けられ、`CAMOUFOX_INSTALL_DIR` として先方へエクスポートされます — camoufox-js 0.12.0+ では `CAMOUFOX_INSTALL_DIR` とまったく同じく、ダウンロード自体を再配置します。 |
| `XDG_CACHE_HOME` | `~/.cache` | 標準の XDG 変数。設定すると、下記のすべての `~/.cache/pi-research/...` パスは代わりに `$XDG_CACHE_HOME/pi-research/...` を基準に置かれます。 |
| `PI_RESEARCH_BIN`（エイリアス `PI_RESEARCH_PATH`） | _（自動）_ | エージェントスキルランチャー専用: 自動解決（PATH → ローカルインストール → npx）をバイパスすべきときに、pi-research エンジンのバイナリへの明示的なパス。[agent-skill/pi-research/references/configuration.md](../agent-skill/pi-research/references/configuration.md) を参照してください。 |
| `PLAYWRIGHT_INSTALL_DEPS` | _（未設定）_ | Linux のみ。`npm install` 中に `true` を設定すると、`npx playwright install-deps` でシステムライブラリもインストールします（`npm run install:system-deps` と同じ）。 |
| `PI_RESEARCH_STRICT_SETUP` | _（未設定）_ | 同梱の `scripts/setup.cjs` が `npm install` 中に読み取ります。`1`/`true` を設定すると、ブラウザのダウンロード失敗が初回使用への先送りではなく、インストールの失敗になります。 |
| `PI_RESEARCH_CONFIG_DIR_NAME` | `.pi` | ホームディレクトリ下のホスト設定ディレクトリ名をオーバーライドします（上級。例: 別のハーネスの設定ルートを共有する）。 |

テスト専用 — 本番では決して有効にしないこと

| 変数 | 説明 |
|----------|-------------|
| `PI_RESEARCH_MOCK_SEARCH` | 実際のウェブデータの代わりに、作為的な検索結果を返します。 |
| `PI_RESEARCH_MOCK_SCRAPE` | 実際のページ内容の代わりに、作為的なスクレイプ結果を返します。 |
| `PI_RESEARCH_FORCE_READY` | 準備チェックをバイパスし、重要なサービスの初期化に失敗していても実行します。**pi 拡張機能のみ** — CLI、エージェントスキル、SDK はこれを参照しません。 |
| `PI_RESEARCH_ALLOW_LOOPBACK_SCRAPE` | **ループバック**アドレス（`127.0.0.0/8`、`::1`、`*.localhost`、`::ffff:127.x`）のスクレイプを許可し、統合テストが実ブラウザとスクレイプパイプラインをローカルサーバーに対して駆動できるようにします。意図的にループバックだけに限定されています。リンクローカルの `169.254.0.0/16`（クラウドメタデータ）と RFC1918 の LAN 範囲は、これを設定してもリクエスト時と接続時の両方でブロックされたままです。 |

### 設定レイヤーの重なり方

設定は次のレイヤーから解決されます。優先度の低いものから高いものへ（後勝ち）:

```
組み込みのデフォルト値
  < ~/.pi/research/config.env                       （ベース、共有。/research-config が編集）
  < ~/.pi/research/{pi,cli}.env                      （フロントエンドごとのオプションのオーバーレイ）
  < cwd のレガシー .pi-research.env                 （廃止予定。レジストリへ自動移行）
  < プロジェクトレジストリ                           （~/.pi/research/state/project-settings.json、ディレクトリごと）
  < process.env                                      （実シェル環境が常に勝つ）
```

ベースファイル。`config.env` には共有のユーザースコープ設定を保存します。`/research-config`
TUI はこのファイル（とプロジェクトレジストリ）だけを編集します — オーバーレイやマージ済みの
ビューは決して編集しません — そのためオーバーレイの値がベースに書き戻されることはありません。

フロントエンドごとのオーバーレイ。各フロントエンドは自分専用のオプションのオーバーレイだけを
読み込み、共有ベースの上に重ねます。そのため、それぞれを独立して設定できます。存在するのは
正確に 2 つです:

- `~/.pi/research/pi.env` — pi 拡張機能
- `~/.pi/research/cli.env` — スタンドアロン CLI / エージェントスキル（スキル対応ホストが実行する
  サーフェス）

オーバーレイファイルはデフォルトでは存在しません。必要なものを手動で作成してください。
`sdk.env` は意図的に存在しません: SDK は（グローバルファイルからではなく）コードから設定される
ライブラリです（[SDK](#sdk) を参照）。

例 — pi 拡張機能に触れずに、スタンドアロン CLI / エージェントスキルに専用のモデルと深度を
与える:

```sh
# ~/.pi/research/config.env   （共有ベースライン）
PI_RESEARCH_KNOWLEDGE_STORE_MODE=project

# ~/.pi/research/cli.env       （スタンドアロン CLI / エージェントスキルのみ）
PI_RESEARCH_MODEL=openrouter/anthropic/claude-sonnet-4-6
PI_RESEARCH_DEFAULT_RESEARCH_DEPTH=2
```

プロジェクトレジストリ。プロジェクトスコープの設定（リサーチ深度とナレッジモード）は、
正規化された作業ディレクトリのパスをキーとして、ディレクトリごとに `project-settings.json` に
保存されます。そのディレクトリに限ってベースとオーバーレイを上書きします。pi 拡張機能では
`/research-config` TUI が書き込みます。スタンドアロン CLI では、ナレッジモードをディレクトリごとに
直接設定できます:

```sh
pi-research knowledge-config                       # ここのモードとその出所を表示
pi-research knowledge-config set <none|project|global>   # 1 つの値を選ぶ
```

エージェントスキルの下では自分で実行する必要はありません — エージェントに頼んでください
（例: "ここではナレッジストアを無効化して" / "プロジェクトスコープにして"）。同じコマンドを
あなたの代わりに実行します。どちらの方法でもレジストリに着地します（優先度は `config.env` より
上）ので、ディレクトリごとの値はマシン全体の `config.env` デフォルトを上書きします。実環境変数は
さらにその両方に勝ります。

process.env. 実環境変数は常に勝ちます。一回だけのオーバーライドには、そのプロセスのために
変数をエクスポートしてください。

> ベースファイルはシェルによって自動的にロードされません。`/research-config` TUI を使う
> （書き込んでくれます）か、シェルで変数をエクスポートするか、direnv のようなローダーを使って
> ください。`.env.example` はリファレンスであり、有効な設定ファイルではありません。

### プロンプトキャッシュ

リサーチの実行は、大きくほぼ不変のプロンプトを何度も再送します。リサーチャーはツールの
ターンごとに会話全体（取得した各ページを含む）を再送し、リサーチリードもかつてはラウンドごとに
蓄積した成果を再送していました。どのプロバイダーでも、この繰り返しはプロンプトキャッシュから
入力価格の一部で供給されます — ただしリクエストの**正確な接頭辞**に限られ、しかも可変の内容が
接頭辞の前に挟まっていない場合に限られます。

pi-research の対策。リサーチリードは 2 つのロールに分割され、繰り返しが（割引ではなく）*除去*
されるようにしました。**ルーター**はラウンドごとに続行するかを決めます。各レポートの全文を、
そのレポートが届いたラウンドだけで読み、以降はその短いカバレッジ要約だけを読みます — それまでの
全レポートを読み返す代わりに。**シンセサイザー**は最後に 1 回だけ実行され、レポート全文を読む
唯一の呼び出しです。分割前は、1 つの呼び出しが両方の役を担い、ラウンドごとにコーパス全体を
再送していたため、入力はラウンド数の 2 乗で増えていました。シンセサイザーのコーパスはモデルの
コンテキスト窓に対しても予算化されます。予算を超えると、レポートは切断や拒否ではなく、部分的な
パスに縮小されてマージされます。

ルーターがどのくらいの頻度で走るかは、ラウンド予算によります。深度 2 と 3 は最終ラウンド以外の
すべてのラウンドでルーティングします。深度 1 の基本予算は 2 ラウンドで最終ラウンドはスキップ
されるため、通常の深度 1 実行がルーティングすることはありません — しかしステアリングは予算を
引き上げ（最大 2 ラウンド追加）、ステアリングされた深度 1 実行はルーティングします。それこそが
最も多くの成果を抱える深度 1 のケースでもあるため、全文コーパスではなく要約に対してルーティング
することの意味が最も大きい場面です。

さらに、リードの 2 つのプロンプトはどちらも安定要素を先頭に配置したレイアウトです。実行全体を
通じて固定の値（複雑度、チームサイズ、クエリ予算、無効化ツール）だけを補間し、ラウンド間で変わる
すべて — ルートクエリ、ラウンド番号、アジェンダ、実行済みクエリ、ステアリング、ラウンドフェーズの
ガイダンス — は、後から `RUN CONTEXT` ブロックとして追加されます。ユニットテストがこのレイアウトを
固定しています。`src/prompts/system-lead-router.md` または
`src/prompts/system-lead-synthesizer.md` を編集する場合は、ラウンド間で変わるテキストを入れたままに
しないでください。

プロバイダー側がどう動くかは、pi がどの API と対話するか（`~/.pi/agent/models.json` の
プロバイダーの `api` フィールド）と、OpenAI 互換エンドポイントでは `compat` キーによります:

| プロバイダー API | 動作 |
|--------------|-----------|
| `anthropic-messages` | pi が `cache_control` ブレークポイントを自動挿入します — システムプロンプト、最後のツール定義、最後のユーザー/アシスタント/ツール結果ブロックに。設定は不要です。 |
| `openai-completions` | `compat.cacheControlFormat` が `"anthropic"` である限り、pi は OpenAI 形状のペイロードに**同じ** Anthropic 風のブレークポイントを挿入します。自動検出は 1 つのケースでのみこのキーを設定します — OpenRouter が `anthropic/*` モデルへルーティングする場合 — それ以外のデフォルトではマーカーは送られず、プロバイダー自身の暗黙的な接頭辞キャッシュに委ねられます。このデフォルトは、OpenAI、DeepSeek、Gemini、GLM に対して正しいものです（いずれも暗黙的にキャッシュします）。 |
| `openai-responses` | どの設定でもマー�カーは送られません。暗黙的キャッシュのみです。 |

マーカーの動作は `api` フィールドではなく `cacheControlFormat` が支配することに注意して
ください — このキーを設定すると、`openai-completions` プロバイダーが `anthropic-messages`
とまったく同じく明示的なブレークポイントを出します。下のカウンタを読むときに重要です: そのように
設定したプロバイダーでは、キャッシュ読み取りがゼロでもマーカーが欠けている証拠にはなりません。

ギャップになるのは、明示的なマーカーを必要としながら OpenAI 互換エンドポイント経由で到達され、
しかもその自動検出ケースに当てはまらないプロバイダーです。そのカテゴリのもの
（OpenRouter 経由の Qwen、または Claude を前に置く任意のゲートウェイ）は、**まったく**キャッシュせず、
無音で、エラーも出しません。プロバイダーごとに `compat` ブロックで修正します:

```json
{
  "providers": {
    "openrouter": {
      "api": "openai-completions",
      "compat": {
        "cacheControlFormat": "anthropic",
        "sessionAffinityFormat": "openrouter",
        "sendSessionAffinityHeaders": true
      }
    }
  }
}
```

`cacheControlFormat: "anthropic"` がマーカーを強制します。プロバイダー全体に対して設定するのは
安全です。マーカーを使わないモデルは余分なフィールドを無視します。2 つのセッションアフィニティの
キーは、OpenRouter に会話をキャッシュを温めたレプリカ上に維持するよう依頼します。これらがないと
OpenRouter は先頭のメッセージ群をハッシュする形にフォールバックし、エージェントループがその内容を
書き換えてしまいます。

`PI_CACHE_RETENTION=long`（pi の変数であり、pi-research のものではありません）は、プロバイダーが
対応している場合に 1 時間の保持を依頼します。キャッシュ書き込みの倍率を 1.25 倍から 2 倍に
引き上げるため、実行内の呼び出し間隔がプロバイダーのデフォルト窓（名目上 5 分）を超えるときにのみ
見合います。

有効化の前に計測してください。GLM に対して `anthropic-messages` 経由の直接テストでは、エントリは
**デフォルト保持で 7 分後**でも変更されずに読み戻され、`long` でも同じ数値でした — この経路では、
倍増した書き込み倍率は何も買っていません。名目上の 5 分はプロバイダーが上回り得る下限であって、
それに基づいて計画できる期限ではありません。

動いているかを検証する。`PI_RESEARCH_DEBUG=true` を設定し、実行ログを読んでください: すべての
LLM 呼び出しは `llm_tokens_total` と並べて `llm_cache_read_tokens_total` と
`llm_cache_write_tokens_total` を記録し、コンポーネント（`coordinator` / `router` / `synthesizer` /
`researcher`）でタグ付けされます。マルチターンのリサーチャーでキャッシュ読み取りがゼロのままなら、
接頭辞が一致していないことを意味します — 通常は、プロバイダーに最小キャッシュ可能な接頭辞
（一般に 1024–4096 トークン）があり短いプロンプトでは届かないか、明示マーカーのプロバイダーに上記の
`compat` ブロックがないかです。カウンタ自体が存在しない（ゼロではない）場合は、プロバイダーが
キャッシュをまったく報告していないことを意味します。

キャッシュ**書き込み**は、2 つのうち弱いシグナルです。多くのプロバイダーは読み取りを報告しながら
書き込みを完全に省略します — OpenRouter と Z.ai の Anthropic 互換エンドポイントはどちらも、ゼロの
`cache_write` と並べて非ゼロの `cache_read` を返します — そのためそこのゼロは正常であり、キャッシュが
機能しているかどうかについて何も語りません。読み取りカウンタで判断してください。

### ファイルの所在地

pi-research の状態はすべて、独自の名前空間 `~/.pi/research/` の下に置かれます:

| パス | 内容 |
|------|----------|
| `~/.pi/research/config.env` | 共有ベース設定（ユーザースコープ設定）。 |
| `~/.pi/research/{pi,cli}.env` | フロントエンドごとのオプションのオーバーレイ。 |
| `~/.pi/research/state/project-settings.json` | プロジェクトレジストリ（ディレクトリごとの設定）。 |
| `~/.pi/research/state/` | アクティブセッション、ブラウザ状態、ロック。 |
| `~/.pi/research/knowledge_db/` | ナレッジストア（LanceDB）。`PI_RESEARCH_KNOWLEDGE_DIR` を設定していればその限りではありません。 |
| `~/.cache/pi-research/profiles/` | 一時的なブラウザプロファイル。`PI_RESEARCH_TMP_DIR` を設定していればその限りではありません。`XDG_CACHE_HOME` が設定されていれば `$XDG_CACHE_HOME` 基準になります。 |
| `~/.cache/pi-research/webgpu-viability.json` | キャッシュされた WebGPU 実行可能性の判定（ナレッジストアのドキュメントを参照）。`XDG_CACHE_HOME` が設定されていれば `$XDG_CACHE_HOME` 基準になります。 |

パスは `PI_RESEARCH_STATE_DIR`、`PI_RESEARCH_KNOWLEDGE_DIR`、`PI_RESEARCH_TMP_DIR` で
再配置できます。

## アーキテクチャ {#architecture}

pi-research は、マルチエージェントのウェブリサーチ向けの pi 用 TUI 拡張機能です。pi の
プロセス内で動作し、ツールとコマンドを登録し、独自のブラウザワーカープール、サービス
レジストリ、ローカルのナレッジストアを管理します。単一のエンジンがすべてのフロントエンドを
支えています: pi 拡張機能に加え、スタンドアロン CLI、ポータブルなエージェントスキル
（スキル対応ホストが実行する同じスキル）、プログラマティックな SDK（`src/sdk.ts`）として
公開されています。

```
pi CLI
└── pi-research 拡張機能（src/index.ts）
    ├── 登録済みツール   research、health、research_knowledge_search（常に登録。ストア無効時には理由を説明）
    ├── コマンド         /research、/research-config、/knowledge-store
    ├── イベント         input（実行中のステアリング）、session_shutdown（クリーンアップ）、session_before_compact / session_compact、before_agent_start、after_provider_response
    └── レイヤー
        ├── オーケストレーション   クイック/ディープリサーチの調整
        ├── エージェントツール  search、scrape、youtube_transcript、security_search、stackexchange、grep、read
        ├── インフラストラクチャ   ブラウザプール、ナレッジストア、ステートマネージャー
        └── コア       サービスレジストリ、スケジューラ、ヘルスチェック
```

1. クエリは `runResearch` — 唯一の内部エントリポイント — に入り、深度を伴います。呼び出し側は
   リクエストを自然言語で表現します: `research` ツールがセッション内で呼び出されたときは、
   呼び出し側のエージェントがユーザーの言い回しとタスクの複雑さから深度（1–3）を選択し、その
   ツールの使用プロンプト（`src/prompts/research-tool-usage.md`）がこれを導きます。CLI と SDK の
   呼び出し側は深度を明示的に渡します。
2. 深度 0 はクイック経路、1–3 はディープ経路（下記）を取ります。pi 拡張機能のツールと TUI は
   1–3 に制限されており、CLI、SDK、エージェントスキルは 0 を渡せます。
3. ディープ経路では、コーディネーターがリサーチの軸を計画し、初期の検索バーストを実行した後、
   結果の URL セットを各リサーチャーに開始地点として引き渡します。
4. リサーチャーはスクレイプツールでこれらのページを取得して読み、引用付きのレポートを返します。
   対象とするのは、このセッションで自分が取得したものだけです。
5. リサーチリードの**ルーター**がそのラウンドを精査し、別のラウンドを実行するかループを終えます。
   その後、**シンセサイザー**が収集済みの全レポートから最終レポートを書き上げます。
6. 結果は引用付きの単一の Markdown レポートとして返され、引用された URL とその要約は、将来の
   実行に備えてナレッジストアのキューに入ります。

### オーケストレーション

`runResearch`（`IResearchOrchestration`。実装は
`src/orchestration/research-orchestration-service.ts`）が唯一の内部エントリポイントで、深度に
応じてディスパッチします。

深度 0 — クイック（`QuickResearchOrchestrator`）: 単一のリサーチャーがすべてのツールを持ち、
直接実行します。コーディネーターもプランニングフェーズもラウンドもありません。深度 0 は SDK
（`runQuickResearch`）または CLI（`--depth 0`。エージェントスキルも渡せます）でのみ到達できます。
pi 拡張機能の `research` ツールの最小深度は 1 なので、セッション内のエージェントがクイックモードを
要求することは決してありません。

深度 1–3 — ディープ（`DeepResearchOrchestrator`）: 実行は**ラウンド**で進みます。1 ラウンドは
「コーディネート → リサーチ → ルート」の 1 サイクルです。ラウンドのアジェンダが計画され
（ラウンド 1 はコーディネーター、以降はリサーチリードの**ルーター**）、1 バッチの**リサーチャー**が
並列に実行し、その後ルーターが別ラウンドを実行するかループを終えるかを決めます。2 つの独立した
制限が適用されます。1 ラウンド*の中で*何人のリサーチャーが動くか、そして実行全体で最大何ラウンド
まで進めるかです。

リサーチリードは、1 つの呼び出しが両方を兼ねるのではなく、2 つのロールです。ルーターは決める
だけです。各レポートの全文はそのレポートが届いた唯一のラウンドで読み、以降はその短いカバレッジ
要約だけを読むため、入力はラウンド数の 2 乗ではなくチームのサイズで増えます。**シンセサイザー**は
正確に 1 回、最後に実行され、各レポートの全文を読んでレポートを書きます — モデルのコンテキスト窓から
導出されたコーパス予算のもとで、コーパスが収まらないときは部分的なパスに縮小してマージします。
2 つのプロンプトは `src/prompts/system-lead-router.md` と `system-lead-synthesizer.md` です。

| 深度 | ラベル | ラウンドごとのリサーチャー数（上限） | ラウンド数（上限） |
|-------|--------|-----------------------------|--------------|
| 1     | normal | 2                           | 2            |
| 2     | deep   | 3                           | 3            |
| 3     | ultra  | 5                           | 3            |

これは目標ではなく上限です: コーディネーターとルーターは、トピックが必要とするだけの
リサーチャーとラウンドを使います。たとえば深度 2 の実行は、最大 3 ラウンドのそれぞれで最大 3 人の
リサーチャーを投入できます。キューに入ったステアリングメッセージ（Alt+Enter）は、上限の上に
数ラウンドの追加を解放できます（`MAX_EXTRA_ROUNDS_WITH_STEERING`）。

コーディネーターは初期の検索バーストも実行し、その結果の URL をラウンド 1 のリサーチャーに配ります
（`distributeSearchResults`）。そのためディープモードでは、リサーチャー自身は `search` を呼び出し
ません。

LLM 呼び出しの規約。コーディネーター、ルーター、シンセサイザー、JSON 修復、ナレッジ抽出の呼び出しは
`completeSimple`（`src/core/llm/pi-ai-completion.ts`）と `buildSafeOptions`
（`src/core/llm/llm-utils.ts`）を通ります。リサーチャーのサブエージェントは
`createAgentSession` を通ります。2 つの規約が適用されます:

- 思考はデフォルトでオフです。これらの呼び出しは構造化 JSON や引用付きレポートを出すため、思考
  連鎖ブロックは出力トークン予算を消費するだけです（回答を切断することもあります）。
  `PI_RESEARCH_LLM_THINKING_LEVEL`（デフォルト `off`）がこれを制御し、プロバイダーごとにクランプ
  されます。
- 出力予算はロールごとにサイズが決まり、モデルの上限にクランプされます: `PLANNING_MAX_TOKENS` は
  プラン/判定に、`SYNTHESIS_MAX_TOKENS` は最終レポートに使用します。ラウンド途中の評価が解析不能
  でも、既存のアジェンダを続行し、早期に打ち切りません。したがって解析の失敗が実行を切断することは
  ありません。

### ツールインベントリ

これは、両方のサーフェスでシステムが露出しているすべてのツールの権威あるリストです。

**ホスト向けツール** — pi セッションに登録され（`src/index.ts`）、呼び出し側のエージェントが使用
します:

| ツール | 目的 |
|------|---------|
| `research` | 完全なマルチソースのリサーチセッションを実行し、引用付きの Markdown レポートを返します |
| `research_knowledge_search` | ナレッジストアの即時ローカル検索 — ライブリサーチの前に確認されます。常に登録され、ストア無効時には理由を説明します |
| `health` | システムの状態を検証します（ブラウザプール、ナレッジストア、GPU ロック）。オプションの生存プローブ付き |

**リサーチャーエージェントのツール** — 各リサーチャーサブエージェントが作業する固定のツールセット
（`src/tools/index.ts`）。`search`、`security_search`、`stackexchange`、`youtube_transcript` は
フェーズごとの 12 回の収集呼び出し予算（`MAX_GATHERING_CALLS`）を共有し、`scrape` とローカルの
`grep` には独自の予算があります:

| ツール | クイック | ディープ | バックエンド |
|------|-------|------|---------|
| `search` | ✓ | — | ステルスブラウザ経由の DuckDuckGo Lite |
| `scrape` | ✓ | ✓ | ステルスブラウザ経由のバッチページ取得 → Markdown（呼び出しごとに最大 MAX_SCRAPE_URLS 件の URL。デフォルト 8） |
| `youtube_transcript` | ✓ | ✓ | youtubei.js + BotGuard PoToken 経由の YouTube 字幕（デフォルト ≤3 動画、1–5 で設定可能。リサーチャーごとに 1 呼び出し） |
| `security_search` | ✓ | ✓ | NVD、CISA KEV、GitHub アドザイサリ、OSV |
| `stackexchange` | ✓ | ✓ | Stack Exchange ネットワーク |
| `grep` | — | — | ローカル ripgrep（pi-coding-agent より）— 常に除外。下記参照 |
| `read` | ✓ | ✓ | ローカルファイル読み取り（pi-coding-agent より） |

ディープリサーチでは `search` は除外されます — コーディネーターが検索バーストを実行し、URL を
直接配るためです。

`grep` は**すべての**深度とすべてのフロントエンド（CLI、SDK、エージェントスキル、pi 拡張機能）で
除外されます: これはウェブリサーチであり、それ以外のときは能力のあるモデルがローカルのファイル
システムを検索するターンを浪費してしまうためです。2 つの除外サーフェス — `excludeTools` リスト
（CLI では `--exclude-tools`、拡張機能では `excludeTools` ツールパラメータ）と
`PI_RESEARCH_DISABLED_TOOLS` — は、このデフォルトの上に厳密に加算されます: 能力を奪うことだけが
できます（[設定](#configuration)を参照）。1.3.10 より前は、空でない `excludeTools` リストがデフォルトを
置き換えていたため、他の任意のツールを名指しすると `grep` が静かに再有効化されていました。

リサーチャーはファイルに書き込めず、シェルコマンドを実行できず、これらのツールの外側のネットワークに
到達できません。

### ブラウザインフラストラクチャ

すべてのブラウザ作業（検索、スクレイプ、ヘルスチェック）は、poolifier の `FixedClusterPool`
ワーカープールを通ります — 各ワーカーは、自分専用の camoufox（ステルス Firefox）インスタンスを実行
する Node.js の子プロセスです。ブラウザをワーカー内に隔離することで、あるワーカーのクラッシュが
オーケストレーターや他のセッションを巻き込むことはありません。

```
BrowserTaskScheduler
└── FixedClusterPool（poolifier）
    ├── Worker 1  →  camoufox インスタンス
    ├── Worker 2  →  camoufox インスタンス
    └── Worker N  →  camoufox インスタンス
```

主要ファイル:
- `src/infrastructure/browser/browser-task-scheduler.ts` — タスクをプールへディスパッチ
- `src/infrastructure/browser/thread-worker.ts` — ワーカーのエントリポイント（esbuild で別個に
  バンドル）
- `src/infrastructure/browser/thread-worker-messaging.ts` — IPC プロトコル
- `src/infrastructure/browser/config.ts` — プール設定、バイナリパス検出

### ナレッジストアとデータ処理

ナレッジストアは、過去の成果を保存するローカルの LanceDB ベクトルテーブルです。オプションで
（なくてもリサーチは動きます）、完全にオーケストレーターが駆動します — リサーチャーが直接呼び出す
ことはありません:

- 各リサーチャーが開始する前に、オーケストレーターがそのリサーチャーの目標でストアを検索し、一致した
  過去の URL（要約付き）を開始地点としてプロンプトに注入します。
- 実行後、引用された URL とその説明は非同期の書き込みキューに入り、バックグラウンドで保存されます —
  書き込みが実行をブロックすることはありません。

取り込み時には、各ソースの要約と完全な取得済み Markdown がチャンクに分割され、ベクトルに埋め込まれ
ます。ページのコンテンツハッシュ（SHA-256）が、再取り込みされた URL を重複排除します: 変更のない
ページはスキップされ、変更のあったページは古い行を置き換えます。各行は、ベクトル、正規化 URL、テキスト
と完全な内容、タイムスタンプ、そして（プロジェクト vs グローバルの）クエリ時にフィルタされるスコープ
フラグを持ちます。

```
WriterQueue（非同期、非ブロッキング）
└── KnowledgeStore
    ├── Embedder（@huggingface/transformers 経由の onnx-community/granite-embedding-small-english-r2-ONNX）
    │   └── バックエンド: auto（プロセス外 WebGPU プローブ → webgpu または cpu）/ webgpu / cpu
    └── LanceDB（knowledge_db/ ディレクトリ、Arrow を基盤とするベクトルテーブル）
```

主要ファイル: `src/knowledge/store.ts`（LanceDB 操作）、`embedder.ts`（モデルロード + バッチ推論）、
`writer-queue.ts`（非同期書き込み + コンテンツハッシュ重複排除）、`chunker.ts`（チャンク分割）、
`webgpu-viability.ts`（プロセス外 GPU プローブ + キャッシュ済み判定）、`migration.ts`（移行戦略の型 —
drop / backup / re-embed のロジック自体は `store.ts` にあります）。

ストアにはネイティブの ONNX ランタイムと LanceDB バインディングが必要です。プリビルドバイナリのない
プラットフォーム — とりわけ Intel macOS（`darwin-x64`）— では欠席します: ヘルスチェックは
「無効だが健全」と報告し、リサーチはキャッシュなしで動作します。サブシステムの全体とプラットフォーム
マトリクスは[ナレッジストア](#knowledge-store)を参照してください。

### サービスとライフサイクル

サービスは非同期のファクトリ関数として登録され、レジストリ（`getService()`）経由で解決されます。
依存は init の時に配線され、遅延または即時に初期化できます。

```typescript
registerService(ServiceNames.FOO, async () => {
  const dep = await getService<IBar>(ServiceNames.BAR);
  return new FooService(dep);
}, { lazyInitialization: true });

const foo = await getService<IFoo>(ServiceNames.FOO);
```

リソースを保持するサービスは `dispose()` を実装し、レジストリが依存の逆順で解放します。レジストリ経由
での解決（直接 import の代わり）は、ライフサイクルの規律（init → 使用 → dispose）を強制し、テストが
モックを差し込めるようにします。

- コア（`src/core/`）: `PlanningService`、`SchedulerService`
- インフラストラクチャ（`src/infrastructure/`）: `StateManagerService`、`KnowledgeStoreService`、
  `MetricsService`、`WorkerPoolManager`、`FileLockService`、`GPUResourceService`（さらに
  `WriterQueue`。`src/knowledge/` で定義され、ここで登録されます）
- オーケストレーション（`src/orchestration/`）: `ResearchOrchestrationService`、
  `ResearchSessionService`、`ResearchSynthesisService`

セッションとプロセスをまたぐ状態（アクティブセッション、ブラウザ状態、メトリクス）は
`StateManagerService`（`src/infrastructure/state/`）にあり、ファイルベースのロック
（`FileLockService`）で並列書き込みを直列化します。

### 並行実行（実行上限）

1 台のマシン上のすべての pi-research プロセス — CLI、エージェントスキル、pi 拡張機能、SDK — は、
リーダー選出で選ばれたブラウザプールと 1 つの埋め込みモデルを共有します。上限のない数のリサーチ
実行をその共有プールに押し込んでも、実行が優雅に遅くなることはありません。プライオリティキューを
飽和させ、*すべての*実行が同時に劣化します。

そこで `ResearchRunSemaphore`
（`src/infrastructure/research-run-semaphore.ts`）が、すべての `runResearch()` の入口に N スロットの
ゲートを設けます。スロットは状態ディレクトリ内の N 個のよく知られたロックファイルとして実体化され、
同じ `FileLockService` が調停します。スロットの所有権は PID + プロセス起動時刻として記録されるため、
クラッシュした実行が保持していたスロットは次の取得時に即座に回収されます。一方、*生きている*ホルダーが
奪われることは決してありません — 正当な実行は数分にわたってスロットを保持し、それを奪うのは上限が
存在する理由そのものである (N+1) 番目の実行を許すことになります。

上限を超えた実行は**失敗ではなくキューに入ります**: 取得はスロットが空くまでポーリングし、オブザーバー
経由で 1 回だけ告知します（`onRunQueued`。CLI では `• queued: …` と表示）。待機中の実行がハングと
誤解されることはありません。キューイング窓全体で何も空かなかった場合にのみ
`ResearchRunCapacityError` が発生します — 一時的な状態であり、CLI はクラッシュと区別して終了コード
`75` で報告します。上限は内部エラー・IO エラーに対して*フェイルオープン*であり、セマフォ自身の失敗が
リサーチの実行を妨げることは決してありません。上限もキューイング窓も設定可能です
（`PI_RESEARCH_MAX_CONCURRENT_RUNS`、`PI_RESEARCH_RUN_ACQUIRE_TIMEOUT_MS`）。

### TUI

リアルタイムの進行状況パネルは `@earendil-works/pi-tui` を使用します。ターミナルの状態（キーボード
プロトコル、マウストラッキング、括弧付きペースト）はこれが扱います。stdio のキャプチャ（散発的な出力が
パネルを壊さないようにし、クリーンな終了を保証する）は `src/utils/stdio-capture.ts` にあります。

### プロジェクト構造

```
src/
├── index.ts              拡張機能のエントリ（ツール、コマンド、イベント、ライフサイクル）
├── cli.ts                スタンドアロン CLI のエントリ
├── sdk.ts                プログラマティック SDK（拡張機能外での使用）
├── config.ts             環境変数の解析、バリデーション、シングルトン
├── constants.ts          チームサイズ、ラウンド上限、ツール予算、バッチ上限
├── logger.ts             構造化ロガー（JSONL、TUI セーフ）
├── tool.ts               research + health ツール定義の再エクスポートのバレル
├── research-config.ts    /research-config TUI
├── core/
│   ├── llm/              プロンプト、モデル解決、エージェント的 JSON 修復、日付注入
│   ├── interfaces/       抽象契約（オブザーバー、プランニング、オーケストレーション）
│   ├── planning-service.ts, scheduler-service.ts
│   ├── service-registry.ts, service-interfaces.ts, service-initialization.ts
│   └── planning-utils.ts
├── infrastructure/
│   ├── browser/          ワーカープール、タスクスケジューラ、IPC、camoufox 設定
│   ├── state/            ステートマネージャー、セッション追跡、メトリクスコレクター
│   ├── embedding/        ローカル埋め込みサーバーの管理
│   ├── knowledge-store-service.ts, metrics-service.ts, file-lock-service.ts
│   └── process-lifecycle-service.ts
├── orchestration/
│   ├── deep-research-orchestrator.ts, quick-research-orchestrator.ts
│   ├── research-orchestration-service.ts, research-synthesis-service.ts
│   ├── research-session-service.ts, session-state.ts, session-context.ts
│   ├── researcher-executor.ts, researcher.ts, headless-observer.ts
├── prompts/              すべてのエージェント用の Markdown プロンプトテンプレート
├── tools/                search, scrape, youtube_transcript, security, stackexchange, grep, read, knowledge-search
├── knowledge/            embedder、store、ライトキュー、chunker、migration、webgpu プローブ
├── web-research/         DuckDuckGo 検索、スクレイパー、リトライロジック
├── security/             NVD、CISA KEV、OSV、GitHub Advisory クライアント
├── stackexchange/        Stack Exchange API クライアント
├── youtube/              YouTube 字幕クライアント（InnerTube + BotGuard PoToken）
├── skill-install/        コーディングエージェントハーネス向けのリサーチスキルインストーラー
├── tui/                  パネル、レイアウト、コントローラー、波アニメーション、ターミナルユーティリティ
├── healthcheck/          ヘルスチェックのレジストリとチェック項目
├── cleanup/              リサーチ結果のクリーンアップ
├── observers/            リサーチオブザーバーの実装
├── types/                共有型と TUI 型
└── utils/                サーキットブレーカー、テキストユーティリティ、共有リンク、メトリクス、エラー追跡
```

### 主要な設計判断

読み取り専用のリサーチャー — リサーチャーエージェントは前述のツールセットに限定されています。
ファイルに書き込めず、プロセスを起動できず、任意のネットワーク呼び出しができません。ただしファイルの
*読み取り*は可能です: `read` は登録されており、リサーチャーの除外リスト（`bash`、`write`、`edit`、
`repl`、`git`、`terminal`）はそれをカバーしません。ローカルの `grep` は登録されていますが常に除外
されます（ツール表を参照）。`read` に渡される `cwd` は解決の基準であって牢獄ではありません — 絶対パス
は自分自身に解決されます — そのため境界は「このディレクトリだけ」ではなく「変更不可」です。

直接ブラウザではなくワーカープール — ブラウザプロセスはワーカー内に隔離され、1 つのクラッシュが
オーケストレーターや他のセッションに影響しません。

固定されたブラウザスタック — `playwright-core` と `impit` は正確なバージョンにピン留めされ、
`camoufox-js` はその `0.12.0` 系列にピン留めされています。3 つは結びついており、一緒にアップグレード
します。どんな浮動範囲も、lockfile が隠していた間に新しい消費者インストールを壊してきたからです。
playwright-core は `1.60.0` に維持します（1.61+ は camoufox の Juggler を拒否し、すべての起動を
失敗させます — 上流で裏付け済み: camoufox-js `0.12.0` は
`peerDependencies: { "playwright-core": "<1.61.0" }` を宣言しており、この手作業で維持している境界と
同じ限界です）。`impit` は正確に `0.14.4`（camoufox の引き上げとともに 2026-08-30 に `0.13.0` から
更新）— 正確にピン留めするのは、npm の `overrides` が消費者へ伝播しないため、下流にバージョンを
強制する唯一の方法が正確なピン留めだからです。impit の `only-allow pnpm` プレインストールガード事故
（0.13.1/0.14.0。0.14.1 で撤去）こそ、ここで浮動範囲を信用しない理由です。完全な根拠:
`src/infrastructure/browser/thread-worker-browser.ts`。

camoufox の 0.10.x→0.12.0 引き上げは、3 つのブロッカーにより 2 回のリフレッシュサイクルにわたって
保留されていましたが、すべて解決済みです: camoufox は `v152.0.4-beta.26`（2026-07-16）で Windows
バイナリを復活させました。impit の pnpm ガードは 0.13.1/0.14.0 にのみ存在しました。そして camoufox-js
0.12 の better-sqlite3 13 への引き上げは、当初すべてのインストールに C++ ツールチェーンを要求するように
見えました。13.0.3 で実測したところ、8 つのプラットフォーム/アーキテクチャの組み合わせすべての
`prebuilds/` は tarball の*内部*に同梱され、node-gyp-build により実行時にロードされます — インストール
スクリプトはなく、消費者が承認すべきものは何もありません。本当に壊れていたのはバインディングではなく
ツールチェーンでした: npm ≤11 が注入する `node-gyp rebuild` は、インストールスクリプトを持たない
binding.gyp を不必要に再コンパイルし（その node-gyp 11.2 は VS2026 CI ランナーイメージを検出でき
ません）、これこそ CI が npm 12 を実行する理由です。今後の引き上げでは、camoufox ではなく先に
better-sqlite3 を検証してください。

対照的に、ブラウザの**バイナリ**はピン留めされておらず、ピン留めもできません。`camoufox-js fetch` は
バージョン引数を受け付けません: `daijro/camoufox` の GitHub リリースを新しいものから古いものへ辿り、
この OS/アーキテクチャのアセットを備えた最初の非プレリリースを採用します。したがって消費者が受け取る
バイナリは、どの camoufox-js がインストールされているかに関係なく、インストール時点で camoufox が
最新に公開したものになります — npm のピン留めはそれを凍結しません。将来の camoufox リリースが、
こちら側に一切の変更なく新しいインストールの起動を壊す可能性があります。実際に Windows アセットは
`v146-hardware` から `v152.0.2-alpha` まで欠落しており、`v152.0.4-beta.26`（2026-07-16）で復活しました。
現在の最新は `v152.0.4-beta.28`（Firefox 152）です。playwright-core `1.60.0` の下で起動・駆動ともに
クリーンであることを直接検証済みで、既存のキャッシュにまだ残っている可能性のある古い
`v135.0.1-beta.24` についても同様です。実務的な含意は、ブラウザの新鮮さが npm のピン留めとは独立して
いることです — 古い `camoufox-js` は古い Firefox を意味しません。このスタックを引き上げるときは、
実際の起動を必ず再検証してください — ユニット/統合スイートはどちらもブラウザをモックしており、
Juggler の不整合を検出できません。

固定されたデータスタック — `apache-arrow` は `21.1.0` の直接依存であり、`overrides` がツリー全体を
この単一バージョンへ強制して、LanceDB と Arrow が 1 つの Arrow インスタンスを共有するようにします
（バージョンがずれた Arrow のコピーは相互運用できません — 一方で構築された配列は他方に拒否されます）。
これは `@lancedb/lancedb` 0.37 が宣言する Arrow の peer 上限（`>=15.0.0 <=18.1.0`）の上に位置します —
override がなければ npm はそもそもこの組み合わせを解決しません — 動作は検証済みですが、
`@lancedb/lancedb` をアップグレードするたびに再検証が必要です。

`21.1.0` が正確なのは、慎重さのためではなく実測された理由によるものです。見た目上 patch に見える
minor を `21.2.0` に上げると、ストアがまったく動かなくなります: LanceDB の Rust 側の Arrow リーダーが
Arrow 21.2 が書くスキーマを解析できず、すべてのテーブルオープンが
`Failed to read IPC file: Arrow error: Parser error: Unable to get root as footer: RangeOutOfBounds …
UnionVariant { variant: "Type::FixedSizeList" }` で失敗します — 実テーブルに触れる 56 個のユニット
テストと 36 個の統合テストがすべて落ちました。この範囲を caret セーフとして扱わないでください。また、
`@lancedb/lancedb` の 0.37 までのすべてのリリースが同じ `<=18.1.0` の Arrow 上限を宣言していることに
も注意してください。したがって LanceDB をアップグレードしても override は消えず、再検証が必要な
組み合わせが変わるだけです。

固定されたバリデーションライブラリ — `typebox` は pi ホストパッケージが依存する正確なバージョンに
ピン留めされています（`@earendil-works/pi-ai` / `@earendil-works/pi-coding-agent` は 0.84.x 系列で
`1.3.7` にピン留め）。各ツールのパラメータスキーマはここで TypeBox で構築され、pi のツールシステムへ
渡されるため、両者は `Value.Check`/`Convert` のセマンティクスで一致していなければなりません。浮動範囲
`^1.1.38` は、新しい消費者インストールが pi よりも新しい TypeBox へ pi-research を解決してしまい、
テストされていないクロスバージョンの組み合わせを配布しました。正確なピン留めにより、pi-research は
pi がバリデーションに使うのと同じバージョンに保たれます。pi ホストと並行して引き上げてください。単独で
ではありません。（`undici` は逆にホストのメジャーに追従します — ホストは undici 8 にあり、pi-research
は安定した `Agent` コネクタ API しか使わないため `^8` に追従します。）

一時的障害へのレジリエンス — すべての LLM 呼び出しは、応答の途中で切断され得るストリーミング
エンドポイント上の潜在的な単一障害点です（undici はこれを `terminated` として提示します）。
コーディネーターとリサーチリードの呼び出しは、一時的なトランスポートの失敗（ソケットの中断、5xx、429、
プロバイダーの過負荷）を、有界な指数バックオフで素早く再試行します — リサーチャーごとの再試行
（`PI_RESEARCH_MAX_RETRIES`）を反映 — それでも失敗した場合は、実行を中止するのではなく決定論的な
フォールバックプランへ劣化します。アプリケーションレベルの LLM タイムアウトは再試行しません
（予算はすでに使い切っています）。直接劣化します。再試行回数は内部の定数であり、設定項目ではありません。

直接 import ではなくレジストリ — サービスはレジストリ経由で登録・解決され、テスト（モック置換）を
支え、init → 使用 → dispose のライフサイクルを強制します。

純粋な ESM — コードベースは ES Modules（`"type": "module"`）です。ワーカーのバンドルは、統合テストや
公開の前に esbuild で構築します（`npm run build:worker`）。

境界の強制 — `docs/deps.svg` は push のたびに再生成され（madge）、アーキテクチャのルールは
dependency-cruiser（`config/tooling/dependency-cruiser.cjs`）によって強制されます。

### 採用技術

ブラウザとスクレイプ

- [Camoufox](https://camoufox.com) — ステルス Firefox
  （[Playwright](https://playwright.dev) 経由で駆動）。検知されない検索とスクレイプのため
- [poolifier](https://github.com/poolifier/poolifier) — ブラウザワーカーの背後にあるワーカープール
- [html-to-markdown](https://github.com/kreuzberg-dev/html-to-markdown) — 取得した HTML を Markdown に
  変換（node-html-markdown が純 JS のフォールバック）
- `pdf-oxide-wasm` — PDF テキスト抽出（Rust/WASM）

ナレッジストアと埋め込み

- [Transformers.js](https://github.com/huggingface/transformers.js) — ローカルの埋め込み推論
  （モデルは ONNX Runtime で実行）
- Google [Dawn](https://dawn.googlesource.com/dawn) — WebGPU バックエンド。`webgpu` の Node
  バインディング経由でアクセス
- [LanceDB](https://lancedb.com) — ディスク上のベクトルデータベース
- [Apache Arrow](https://arrow.apache.org) — ベクトルテーブルが構築される列指向スキーマ

YouTube 字幕

- [youtubei.js](https://github.com/LuanRT/YouTube.js) — YouTube 内部 API クライアント
- [BgUtils](https://github.com/LuanRT/BgUtils) — BotGuard PoToken の生成
- [jsdom](https://github.com/jsdom/jsdom) — PoToken をミントするための DOM 環境

ホストとランタイム

- [pi](https://github.com/earendil-works/pi) — ホストランタイム、エージェント SDK、TUI ツールキット
- [TypeBox](https://github.com/sinclairzx81/typebox) — ランタイム設定スキーマとバリデーション

### 開発

```bash
npm run test:unit         # ユニットテスト。ブラウザ不要
npm run test:integration  # camoufox が必要（オプトインの仮想ディスプレイテストのみ Xvfb）
npm run type-check        # TypeScript 厳格モード（src）
npm run type-check:tests  # TypeScript 厳格モード（tests）
npm run type-check:native        # TS7 ネイティブコンパイラで同じチェックを実行（ピン留め済み。約 9 倍速い）
npm run type-check:native:tests  # TS7 ネイティブチェック。tests プロジェクト
npm run lint              # ESLint
npm run deps:check        # アーキテクチャルールの強制
npm run build:worker      # ブラウザワーカーのバンドル（統合テスト / 公開の前に必須）
```
