window.__ModuleLoader__.load({
	id: "dsh-coderef",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		/**
		 * dsh-coderef — Client half (prototype, approach #1)
		 *
		 * Registers a shadow occupant of `conversation.chat.node[assistant-step]`
		 * (priority -1; lowest priority renders) and renders the ORIGINAL host
		 * renderer `AssistantNodeView` with two input substitutions:
		 *
		 *   1. settled text blocks: `**X**` -> `` `X` `` only for symbols the Host
		 *      resolved (streaming blocks pass through untouched, so the
		 *      incremental Markdown parser never sees a non-prefix rewrite);
		 *   2. `fileMentions`: a composed resolver where our symbols resolve to a
		 *      clickable inline-code mention whose click opens the IDE (Host
		 *      `/coderef/open`) and falls back to `props.openFile(path,{line})`
		 *      (DSH right-sidebar preview to line) when the IDE launch fails.
		 *
		 * Requires the local DSH source patch that exports `AssistantNodeView`
		 * from `@deepseek-ai/dsh-client-ui-chat` (see README).
		 *
		 * @module dsh-coderef/client
		 */

		const React = require("react");
		const { useCallback, useEffect, useMemo, useState, createElement } = React;

		const PLUGIN_ID = "dsh-coderef";
		const API_PREFIX = "/coderef";
		const VERSION = "0.0.6";

		/** Candidate shape inside one `**...**` span: identifier or dotted member path. */
		const CANDIDATE_PATTERN = /\*\*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\*\*/g;
		const CANDIDATE_TEST = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;

		/** Tokens that are emphasis, tool names, or language keywords — never linkified. */
		const BLACKLIST = new Set([
			"important", "note", "warning", "tip", "todo", "fixme", "danger", "caution", "hint", "key",
			"read", "write", "edit", "grep", "glob", "bash", "pwsh", "shell", "terminal", "line", "file", "path",
			"true", "false", "null", "undefined", "return", "class", "function", "interface", "type", "enum",
			"const", "let", "var", "async", "await", "export", "import", "default", "string", "number",
			"boolean", "object", "array", "promise", "the", "and", "not", "this", "that", "with",
		]);

		/**
		 * Whether one bold token is worth sending to the resolver.
		 * @param {string} name
		 * @returns {boolean}
		 */
		function isUsefulCandidate(name) {
			if (typeof name !== "string") return false;
			if (name.length < 2 || name.length > 80) return false;
			if (BLACKLIST.has(name.toLowerCase())) return false;
			// 1–3 all-caps letters are usually emphasis (OK/API is allowed at 3+, keep 3-letter).
			if (/^[A-Z]{1,2}$/.test(name)) return false;
			return true;
		}

		/** Cross-message resolve cache: `${sessionId}|${cwd}|${text}` -> { item, at }. */
		const tokenCache = new Map();
		const TOKEN_TTL_MS = 5 * 60 * 1000;
		function cacheKeyOf(sessionId, cwd, text) {
			return `${sessionId ?? ""}|${cwd ?? ""}|${text}`;
		}
		function cachedItem(sessionId, cwd, text) {
			const key = cacheKeyOf(sessionId, cwd, text);
			const entry = tokenCache.get(key);
			if (entry === undefined) return undefined;
			if (Date.now() - entry.at > TOKEN_TTL_MS) {
				tokenCache.delete(key);
				return undefined;
			}
			return entry.item;
		}
		function rememberItem(sessionId, cwd, text, item) {
			if (tokenCache.size > 600) tokenCache.delete(tokenCache.keys().next().value);
			tokenCache.set(cacheKeyOf(sessionId, cwd, text), { item, at: Date.now() });
		}

		const EMPTY_MAP = new Map();
		const warned = { stock: false, resolve: false };

		/** Debug surface for the browser console / smoke tests. */
		const debug = {
			version: VERSION,
			stock: "unknown",
			resolves: 0,
			lastError: null,
			lastResolve: null,
			lastPing: null,
			lastOpen: null,
			requireProbe: null,
		};
		if (typeof window !== "undefined") window.__dshCoderef = debug;

		function warnOnce(key, message, error) {
			if (warned[key]) return;
			warned[key] = true;
			if (error === undefined) console.warn(`[${PLUGIN_ID}] ${message}`);
			else console.warn(`[${PLUGIN_ID}] ${message}`, error);
		}

		/**
		 * Read the patched host renderer from the client module table.
		 * @returns {Function|undefined} the stock AssistantNodeView
		 */
		/** Cached stock renderer (undefined = not resolved yet, false = unavailable). */
		let stockCache;
		function getStockAssistantNodeView() {
			if (stockCache !== undefined) return stockCache || undefined;
			try {
				const uiChat = require("@deepseek-ai/dsh-client-ui-chat");
				const stock = uiChat !== null && typeof uiChat === "object" ? uiChat.AssistantNodeView : undefined;
				// AssistantNodeView is wrapped in React.memo: memo returns an OBJECT
				// ($$typeof: react.memo), not a function. Accept any renderable type.
				const valid = typeof stock === "function"
					|| (stock !== null && typeof stock === "object" && stock.$$typeof !== undefined);
				stockCache = valid ? stock : false;
				debug.stock = valid ? "ok" : "missing";
				if (!valid) {
					warnOnce("stock", "宿主 ui-chat 未导出可渲染的 AssistantNodeView —— 请应用本地源码补丁并重建客户端（见 README）");
				}
				return valid ? stock : undefined;
			} catch (error) {
				debug.stock = "error";
				debug.lastError = String(error && error.message ? error.message : error);
				warnOnce("stock", "require('@deepseek-ai/dsh-client-ui-chat') 失败 —— 宿主补丁缺失或版本不匹配", error);
				stockCache = false;
				return undefined;
			}
		}

		/**
		 * Collect unique candidate symbols from one block list.
		 * @param {readonly any[]} blocks assistant blocks
		 * @returns {string[]} candidate texts, in first-seen order
		 */
		function collectCandidates(blocks) {
			const found = [];
			const seen = new Set();
			for (const block of Array.isArray(blocks) ? blocks : []) {
				if (block === null || typeof block !== "object" || block.kind !== "text" || typeof block.text !== "string") continue;
				CANDIDATE_PATTERN.lastIndex = 0;
				let match;
				while ((match = CANDIDATE_PATTERN.exec(block.text)) !== null) {
					const name = match[1];
					if (!isUsefulCandidate(name)) continue;
					if (seen.has(name)) continue;
					seen.add(name);
					found.push(name);
				}
			}
			return found;
		}

		/**
		 * Rewrite only resolved `**X**` spans into inline code so the host file
		 * mention vocabulary can pick them up. Other spans and blocks stay as-is.
		 * @param {readonly any[]} blocks assistant blocks
		 * @param {Map<string, any>} hits resolved symbol -> { file, line, kind, ... }
		 * @returns {readonly any[]} new block array when anything changed
		 */
		function linkifyBlocks(blocks, hits) {
			if (!(hits instanceof Map) || hits.size === 0) return blocks;
			let changed = false;
			const next = (Array.isArray(blocks) ? blocks : []).map(block => {
				if (block === null || typeof block !== "object" || block.kind !== "text" || typeof block.text !== "string") return block;
				const text = block.text.replace(CANDIDATE_PATTERN, (whole, name) => {
					if (!hits.has(name)) return whole;
					changed = true;
					return "`" + name + "`";
				});
				return text === block.text ? block : { ...block, text };
			});
			return changed ? next : blocks;
		}

		function isCandidate(value) {
			return typeof value === "string" && value.length <= 120 && CANDIDATE_TEST.test(value);
		}

		/** Absolute or relative source-file path appearing in tool args / inline code. */
		const HINT_ABSOLUTE = /^[A-Za-z]:[\\/][^\s"'`<>|]+\.(?:tsx?|jsx?|mjs|cjs|py|go|rs|java|kt|cs|rb|php|swift)$/i;
		const HINT_RELATIVE = /^(?:\.{0,2}[\\/])?[\w.$@-]+(?:[\\/][\w.$@-]+)+\.(?:tsx?|jsx?|mjs|cjs|py|go|rs|java|kt|cs|rb|php|swift)$/i;

		/**
		 * Collect source-file hints for this message: tool-call argument paths
		 * (absolute, as the agent touched them) and inline-code paths in the
		 * prose. The Host indexes these files on demand so symbols from files
		 * outside the session cwd still resolve (history-first resolution).
		 * @param {readonly any[]} blocks assistant blocks
		 * @param {string|undefined} cwd session working directory
		 * @returns {string[]} absolute candidate file paths, de-duplicated
		 */
		function collectHints(blocks, cwd) {
			const hints = new Set();
			const add = value => {
				if (typeof value !== "string") return;
				let text = value.trim();
				if (text.length === 0 || text.length > 300) return;
				if (text.startsWith("file://")) {
					try {
						text = decodeURIComponent(new URL(text).pathname);
						if (/^\/[A-Za-z]:/.test(text)) text = text.slice(1);
					} catch {
						return;
					}
				}
				text = text.replace(/:\d+(?::\d+)?$/, "");
				if (HINT_ABSOLUTE.test(text)) {
					hints.add(text);
					return;
				}
				if (typeof cwd === "string" && cwd.length > 0 && HINT_RELATIVE.test(text)) {
					const forward = cwd.includes("/");
					const normalized = forward ? text.replace(/\\/g, "/") : text.replace(/\//g, "\\");
					const separator = cwd.endsWith("\\") || cwd.endsWith("/") ? "" : (forward ? "/" : "\\");
					hints.add(cwd + separator + normalized.replace(/^\.\//, ""));
				}
			};
			const walk = value => {
				if (typeof value === "string") {
					add(value);
					return;
				}
				if (Array.isArray(value)) {
					for (const item of value) walk(item);
					return;
				}
				if (value !== null && typeof value === "object") {
					for (const item of Object.values(value)) walk(item);
				}
			};
			for (const block of Array.isArray(blocks) ? blocks : []) {
				if (block === null || typeof block !== "object") continue;
				if (block.kind === "tool-call" && typeof block.arguments === "string") {
					try {
						walk(JSON.parse(block.arguments));
					} catch {
						// Streamed/truncated args: fall back to inline-code hints only.
					}
				}
				if (block.kind === "text" && typeof block.text === "string") {
					const code = /`([^`\n]{3,300})`/g;
					let match;
					while ((match = code.exec(block.text)) !== null) add(match[1]);
				}
			}
			return [...hints].slice(0, 20);
		}

		/**
		 * Relative source-file paths quoted in the prose (model prose is usually
		 * repo-relative). The Host matches these by suffix against the files
		 * discovered from the session's tool calls, so no cwd guess is needed.
		 * @param {readonly any[]} blocks assistant blocks
		 * @returns {string[]} normalized relative paths
		 */
		function collectRelativePaths(blocks) {
			const out = new Set();
			for (const block of Array.isArray(blocks) ? blocks : []) {
				if (block === null || typeof block !== "object" || block.kind !== "text" || typeof block.text !== "string") continue;
				const code = /`([^`\n]{8,300})`/g;
				let match;
				while ((match = code.exec(block.text)) !== null) {
					const text = match[1].replace(/:\d+(?::\d+)?$/, "").trim();
					if (text.length === 0 || text.startsWith("/") || /^[A-Za-z]:/.test(text)) continue;
					if (!HINT_RELATIVE.test(text)) continue;
					out.add(text.replace(/\\/g, "/").replace(/^\.\//, ""));
				}
			}
			return [...out].slice(0, 20);
		}

		/** Inline-code tokens that are worth asking the Host about (paths, symbols). */
		const INLINE_PATH_HINT = /[\\/]|\.(?:tsx?|jsx?|mjs|cjs|json|md|py|go|rs|java|kt|cs|rb|php|swift|scala|lua|ya?ml|toml)(?::\d+(?:-\d+)?)?$/i;
		const INLINE_IDENTIFIER = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:\(\))?$/;
		const INLINE_BLACKLIST = new Set([
			"node", "npx", "pnpm", "npm", "git", "cd", "stock", "line", "seq", "mentions", "props", "data",
			"kind", "text", "type", "value", "name", "path", "file", "http", "https", "true", "false",
			"null", "undefined", "return", "class", "function", "interface", "const", "let", "var",
		]);

		/**
		 * Whether one inline-code span is a plausible reference (file path or
		 * identifier-like symbol) rather than an arbitrary code fragment.
		 * @param {string} value
		 * @returns {boolean}
		 */
		function isInlineCandidate(value) {
			if (typeof value !== "string") return false;
			const text = value.trim();
			if (text.length < 3 || text.length > 220) return false;
			if (/[*`\n]/.test(text)) return false;
			if (/^(?:https?:|mailto:|data:)/i.test(text)) return false;
			if (/^(?:node|npx|pnpm|npm|git|cd|echo|curl)\s/.test(text)) return false;
			const pathLike = INLINE_PATH_HINT.test(text);
			if (pathLike && !/\s/.test(text)) return true;
			if (INLINE_IDENTIFIER.test(text)) {
				if (INLINE_BLACKLIST.has(text.toLowerCase())) return false;
				if (text.length < 4) return false;
				if (/[A-Z]/.test(text) || text.includes(".")) return true;
			}
			// Expressions: keep tokens that contain a resolvable-looking reference
			// (`require(...).AssistantNodeView`, `findMemberInLines:713`,
			// `props.fileMentions`, `composeMentions()`).
			if (text.length > 200) return false;
			if (/^[<{\[*#]/.test(text)) return false;
			const pathInside = /(?:[A-Za-z]:)?(?:[\w.$@-]+[\\/])*[\w.$@-]+\.(?:tsx?|jsx?|mjs|cjs|json|md|py|go|rs|java|kt|cs|rb|php|swift|scala|lua|ya?ml|toml)(?::\d+(?:-\d+)?)?/i.test(text);
			const symbolWithLine = /\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s*:\s*\d+/.test(text);
			const dottedUpper = /\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+/.test(text) && /[A-Z]/.test(text);
			const callUpper = /\b[A-Za-z_$][\w$]*\s*\(/.test(text) && /[A-Z]/.test(text);
			const pascal = /\b[A-Z][A-Za-z0-9_$]{3,}\b/.test(text);
			return pathInside || symbolWithLine || dottedUpper || callUpper || pascal;
		}

		/**
		 * Collect inline-code spans that could become clickable references. The
		 * host renderer calls fileMentions.resolve(value) for every inline code
		 * span, so resolved entries become chips without rewriting the markdown.
		 * @param {readonly any[]} blocks assistant blocks
		 * @returns {string[]} candidate tokens
		 */
		function collectInlineCandidates(blocks) {
			const found = [];
			const seen = new Set();
			for (const block of Array.isArray(blocks) ? blocks : []) {
				if (block === null || typeof block !== "object" || block.kind !== "text" || typeof block.text !== "string") continue;
				const code = /`([^`\n]{2,300})`/g;
				let match;
				while ((match = code.exec(block.text)) !== null) {
					const value = match[1].trim();
					if (seen.has(value) || !isInlineCandidate(value)) continue;
					seen.add(value);
					found.push(value);
					if (found.length >= 60) return found;
				}
			}
			return found;
		}

		const EVIDENCE_LABEL = { grep: "grep 命中", read: "read 命中", hint: "引用文件", index: "索引", snippet: "代码片段" };

		function formatTitle(hit) {
			const lineLabel = hit.endLine !== undefined && Number(hit.endLine) > Number(hit.line)
				? `${hit.line}-${hit.endLine}`
				: `${hit.line}`;
			const base = `${hit.file}:${lineLabel}` + (typeof hit.kind === "string" ? ` · ${hit.kind}` : "");
			const evidence = typeof hit.evidence === "string" ? (EVIDENCE_LABEL[hit.evidence] ?? hit.evidence) : "";
			const alternatives = typeof hit.candidateCount === "number" && hit.candidateCount > 1 ? `（${hit.candidateCount} 个候选）` : "";
			const legacy = typeof hit.ambiguous === "number" && hit.ambiguous > 1 ? `（${hit.ambiguous} 个同名候选，已取最佳）` : "";
			return [base, evidence === "" ? "" : ` · ${evidence}`, alternatives, legacy].join("");
		}

		/**
		 * Project resolved items onto the mention channel: only `linked` items
		 * with a chosen candidate become clickable references.
		 * @param {Map<string, any>} items resolve items keyed by token
		 * @returns {Map<string, any>} token -> hit used by linkify/composeMentions
		 */
		function linkedHits(items) {
			const linked = new Map();
			if (!(items instanceof Map)) return linked;
			for (const [text, item] of items) {
				if (item === null || item === undefined) continue;
				if (item.status !== "linked" || item.chosen === null || item.chosen === undefined) continue;
				linked.set(text, {
					...item.chosen,
					evidence: item.chosen.evidence ?? "index",
					candidateCount: Array.isArray(item.candidates) ? item.candidates.length : 1,
				});
			}
			return linked;
		}

		/**
		 * Fuse split references like `` `EVIDENCE_SCORE`（`:493`） `` into one
		 * `` `EVIDENCE_SCORE:493` `` chip (display-time only, no model rewrite).
		 * @param {readonly any[]} blocks assistant blocks
		 * @param {Map<string, any>} hits resolved references
		 * @returns {{ blocks: readonly any[], extra: Map<string, any> }}
		 */
		function fuseLineSuffix(blocks, hits) {
			if (!(hits instanceof Map) || hits.size === 0) return { blocks, extra: EMPTY_MAP };
			let changed = false;
			const extra = new Map();
			const pattern = /`([^`\n]{1,200})`\s*[（(]\s*`(:(\d+(?:-\d+)?))`\s*[）)]/g;
			const next = (Array.isArray(blocks) ? blocks : []).map(block => {
				if (block === null || typeof block !== "object" || block.kind !== "text" || typeof block.text !== "string") return block;
				const text = block.text.replace(pattern, (whole, name, _colonRange, digits) => {
					const hit = hits.get(name);
					if (hit === undefined) return whole;
					const range = String(digits);
					const line = Number(range.split("-")[0]);
					extra.set(`${name}:${range}`, { ...hit, line, column: 1, candidateCount: 1, kind: hit.kind ?? "file" });
					changed = true;
					return "`" + name + ":" + range + "`";
				});
				return text === block.text ? block : { ...block, text };
			});
			return { blocks: changed ? next : blocks, extra };
		}

		async function postJson(path, body) {
			const response = await fetch(API_PREFIX + path, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			return await response.json();
		}

		/**
		 * Click target for one resolved reference.
		 *
		 * The sidebar preview is the always-on jump (and the line ping rides on
		 * it); the IDE is a best-effort follow-up that never blocks or replaces
		 * that jump.
		 * @param {any} props chat node props (openFile fallback)
		 * @param {any} hit resolved symbol
		 */
		async function openReference(props, hit) {
			const file = hit.file;
			const line = hit.line;
			let previewOpened = false;
			// 1) Sidebar first: always jump + highlight, regardless of IDE.
			try {
				if (props !== null && props !== undefined && typeof props.openFile === "function") {
					await props.openFile(file, { line });
					previewOpened = true;
					pingLine(line, hit.endLine);
				}
			} catch (error) {
				warnOnce("open", "openFile 预览跳转失败", error);
			}
			// 2) IDE last, best effort (async spawn on the Host side).
			let ideOpened = false;
			try {
				const result = await postJson("/open", { file, line, column: hit.column || 1 });
				ideOpened = result !== null && result.ok === true;
				if (!ideOpened) debug.lastError = result !== null && typeof result.error === "string" ? result.error : "open-failed";
			} catch (error) {
				debug.lastError = String(error && error.message ? error.message : error);
			}
			debug.lastOpen = { file, line, previewOpened, ideOpened, at: Date.now() };
			// 3) Neither target worked: keep the location reachable via clipboard.
			if (!previewOpened && !ideOpened && typeof navigator !== "undefined" && navigator.clipboard !== undefined) {
				try {
					await navigator.clipboard.writeText(`${file}:${line}`);
				} catch {
					// ignore clipboard denial
				}
			}
		}

		const PING_CLASS = "dsh-coderef-line-ping";
		const PING_STYLE_ID = "dsh-coderef-ping-style";
		let pingStyleInstalled = false;
		let pingGeneration = 0;

		/** Inject the one-time highlight/ping stylesheet. */
		function ensurePingStyle() {
			if (pingStyleInstalled || typeof document === "undefined") return;
			pingStyleInstalled = true;
			const style = document.createElement("style");
			style.id = PING_STYLE_ID;
			style.textContent = [
				".dsh-coderef-line-ping {",
				"  background: rgba(84, 150, 255, 0.22) !important;",
				"  box-shadow: inset 3px 0 0 0 rgba(84, 150, 255, 0.9);",
				"  animation: dsh-coderef-ping 2.4s ease-out 1;",
				"}",
				"pre code > .line.dsh-coderef-line-ping { display: block; }",
				"@keyframes dsh-coderef-ping {",
				"  0% { background: rgba(84, 150, 255, 0.55); }",
				"  45% { background: rgba(84, 150, 255, 0.24); }",
				"  100% { background: rgba(84, 150, 255, 0.18); }",
				"}",
			].join("\n");
			document.head.appendChild(style);
		}

		/**
		 * Find the visible preview rows for one source line / line range.
		 * @param {number} line 1-based first line
		 * @param {number} endLine 1-based last line
		 * @returns {Array<{row: HTMLElement, container: HTMLElement|null}>}
		 */
		function findPreviewRows(line, endLine) {
			const rows = [];
			const last = Math.max(line, endLine);
			for (const pane of document.querySelectorAll("[data-code-preview], [data-document-preview]")) {
				if (!(pane instanceof HTMLElement) || pane.getClientRects().length === 0) continue;
				const codeLines = pane.querySelectorAll("pre .line");
				if (codeLines.length === 0) continue;
				const container = pane.querySelector("[data-code-block-content]") ?? pane;
				for (let index = line - 1; index < Math.min(last, line - 1 + 200) && index < codeLines.length; index += 1) {
					const row = codeLines[index];
					if (row instanceof HTMLElement) rows.push({ row, container });
				}
				if (rows.length > 0) return rows;
			}
			for (let current = line; current <= last; current += 1) {
				const row = document.querySelector(`[data-textpreview-line="${current}"]`);
				if (row instanceof HTMLElement && row.getClientRects().length > 0) {
					rows.push({ row, container: row.closest('[data-textpreview-state="text"]') ?? row.parentElement });
				}
			}
			return rows;
		}

		/**
		 * Highlight (ping) the jumped-to line in the right-sidebar preview.
		 * The sidebar's own navigation only scrolls; this adds a short-lived
		 * flash + range background without touching the host bundle.
		 * @param {number} line 1-based line
		 * @param {number|undefined} endLine optional 1-based range end
		 */
		function pingLine(line, endLine) {
			if (typeof document === "undefined" || !Number.isFinite(line)) return;
			ensurePingStyle();
			const generation = (pingGeneration += 1);
			const start = Math.max(1, Math.floor(line));
			const end = Number.isFinite(endLine) ? Math.max(start, Math.floor(endLine)) : start;
			const deadline = Date.now() + 6000;
			const attempt = () => {
				if (generation !== pingGeneration) return;
				const rows = findPreviewRows(start, Math.min(end, start + 200));
				if (rows.length === 0) {
					if (Date.now() < deadline) setTimeout(attempt, 120);
					return;
				}
				const container = rows[0].container;
				if (container instanceof HTMLElement) {
					const top = Math.max(0, rows[0].row.offsetTop - container.clientHeight * 0.35);
					try {
						container.scrollTo({ top, behavior: "smooth" });
					} catch {
						container.scrollTop = top;
					}
				}
				for (const { row } of rows) {
					row.classList.remove(PING_CLASS);
					row.classList.add(PING_CLASS);
					setTimeout(() => { row.classList.remove(PING_CLASS); }, 2600);
				}
				debug.lastPing = { line: start, end, rows: rows.length, at: Date.now() };
			};
			attempt();
		}

		/**
		 * Compose the host file-mention resolver with our symbol vocabulary.
		 * @param {Function|undefined} baseFileMentions host (owner) => MarkdownFileMentions | undefined
		 * @param {Map<string, any>} hits resolved symbols
		 * @param {() => any} getProps latest props accessor
		 * @returns {Function} (owner) => MarkdownFileMentions
		 */
		function composeMentions(baseFileMentions, hits, getProps) {
			return function mentionsFor(owner) {
				let base;
				try {
					base = typeof baseFileMentions === "function" ? baseFileMentions(owner) : undefined;
				} catch {
					base = undefined;
				}
				return {
					resolve(value) {
						const hit = hits.get(value);
						if (hit !== undefined) {
							return {
								label: value,
								title: formatTitle(hit),
								open: () => { void openReference(getProps(), hit); },
							};
						}
						if (base !== undefined && typeof base.resolve === "function") {
							try {
								return base.resolve(value);
							} catch {
								return undefined;
							}
						}
						return undefined;
					},
				};
			};
		}

		/**
		 * Whether this assistant step is the closing message of a closed Turn —
		 * the only state in which the host renderer computes `mentions` and
		 * therefore the only state where rewriting text is safe (otherwise the
		 * `**X**` -> `` `X` `` rewrite would lose bold without gaining a link).
		 * Mirrors the stock AssistantNodeView owner computation.
		 * @param {any} props chat node props
		 * @param {any} tail `useTurnData('turn-tail')` snapshot
		 * @returns {boolean}
		 */
		function hasClosingOwner(props, tail) {
			const node = props !== null && props !== undefined ? props.node : undefined;
			const data = node !== null && typeof node === "object" ? node.data : undefined;
			if (data === null || typeof data !== "object" || data.finalNode === undefined) return false;
			const location = node.location;
			const turn = location !== null && typeof location === "object" && (location.kind === "turn" || location.kind === "step")
				? location.turn
				: undefined;
			if (turn === undefined || turn === null || turn.status !== "closed") return false;
			const closing = tail !== null && typeof tail === "object" ? tail.closing : undefined;
			const finalNode = closing !== null && typeof closing === "object" ? closing.finalNode : undefined;
			return finalNode !== undefined && finalNode !== null && finalNode.seq === data.finalNode.seq;
		}

		/** Client context captured by apply(), used for current-Session discovery. */
		let clientCtx = null;

		/**
		 * Resolve the currently viewed Session id from client services (same
		 * fallback order as dsh-ehm's helper: workspace selection, session
		 * binding, retained session list).
		 * @returns {string|undefined}
		 */
		function resolveCurrentSessionId() {
			if (clientCtx === null) return undefined;
			const get = name => {
				try {
					return typeof clientCtx.get === "function" ? clientCtx.get(name) : undefined;
				} catch {
					return undefined;
				}
			};
			try {
				const selected = get("uiWorkspace")?.selection?.getSnapshot?.();
				if (selected !== null && selected !== undefined && typeof selected.sessionId === "string" && selected.sessionId !== "") {
					return selected.sessionId;
				}
			} catch {
				// fall through
			}
			try {
				const binding = get("uiSession")?.adapter?.current?.getSnapshot?.();
				if (binding !== null && binding !== undefined && typeof binding.key === "string" && binding.key !== "") {
					return binding.key;
				}
			} catch {
				// fall through
			}
			try {
				const snapshot = get("sessions")?.list?.getSnapshot?.();
				const byId = snapshot !== null && snapshot !== undefined ? snapshot.byId : undefined;
				if (byId !== null && byId !== undefined && typeof byId === "object") {
					for (const id of Object.keys(byId)) {
						const retained = byId[id]?.retainedBy;
						if (retained !== null && retained !== undefined && retained.mainView > 0) return id;
					}
				}
			} catch {
				// fall through
			}
			return undefined;
		}

		/**
		 * Create the shadow assistant-step component.
		 * @returns {Function} React component honoring ChatNodeViewProps<'assistant-step'>
		 */
		function createAssistantStep() {
			return function CoderefAssistantStep(props) {
				const node = props !== null && props !== undefined ? props.node : undefined;
				const data = node !== null && typeof node === "object" ? node.data : undefined;
				const blocks = data !== null && typeof data === "object" && Array.isArray(data.blocks) ? data.blocks : EMPTY_BLOCKS;
				const streaming = data !== null && typeof data === "object" && data.status === "running";
				const tail = typeof props.useTurnData === "function" ? props.useTurnData("turn-tail") : undefined;
				const ownerReady = hasClosingOwner(props, tail);

				const candidates = useMemo(() => (streaming ? EMPTY_CANDIDATES : collectCandidates(blocks)), [streaming, blocks]);
				const inlineCandidates = useMemo(() => (streaming ? EMPTY_CANDIDATES : collectInlineCandidates(blocks)), [streaming, blocks]);
				const candidateKey = candidates.length === 0 ? "" : candidates.join("\u0000");
				const inlineKey = inlineCandidates.length === 0 ? "" : inlineCandidates.join("\u0000");
				const tokenKey = candidateKey + "\u0002" + inlineKey;
				const hints = useMemo(
					() => (streaming ? EMPTY_CANDIDATES : collectHints(blocks, typeof props.cwd === "string" ? props.cwd : undefined)),
					[streaming, blocks, props.cwd],
				);
				const relativeHints = useMemo(
					() => (streaming ? EMPTY_CANDIDATES : collectRelativePaths(blocks)),
					[streaming, blocks],
				);
				const sessionId = resolveCurrentSessionId();
				const hintKey = [hints.join("\u0000"), "\u0001", relativeHints.join("\u0000"), "\u0001", sessionId ?? ""].join("");

				const [resolved, setResolved] = useState(null);

				useEffect(() => {
					if (streaming || (candidateKey === "" && inlineKey === "")) return undefined;
					if (resolved !== null && resolved.key === tokenKey && resolved.hintKey === hintKey) return undefined;
					let cancelled = false;
					const cwd = typeof props.cwd === "string" ? props.cwd : undefined;
					if (cwd === undefined) return undefined;
					const cachedEntries = [];
					const missingBold = [];
					const missingInline = [];
					for (const text of candidates) {
						const item = cachedItem(sessionId, cwd, text);
						if (item === undefined) missingBold.push(text);
						else cachedEntries.push([text, item]);
					}
					for (const text of inlineCandidates) {
						const item = cachedItem(sessionId, cwd, text);
						if (item === undefined) missingInline.push(text);
						else cachedEntries.push([text, item]);
					}
					const missingCount = missingBold.length + missingInline.length;
					const applyItems = (entries, result) => {
						const items = new Map(entries);
						const statusCounts = { linked: 0, ambiguous: 0, unresolved: 0 };
						for (const item of items.values()) {
							if (item !== null && typeof item === "object" && statusCounts[item.status] !== undefined) statusCounts[item.status] += 1;
						}
						debug.resolves += 1;
						debug.lastResolve = {
							cwd,
							sessionId: sessionId ?? null,
							candidates: candidates.length,
							inlineCandidates: inlineCandidates.length,
							requested: missingCount,
							cached: cachedEntries.length,
							hints: hints.length,
							relativeHints: relativeHints.length,
							hintList: hints.slice(0, 6),
							hits: statusCounts.linked,
							statusCounts,
							inlineLinked: result !== null && result !== undefined && result.inline !== undefined ? result.inline.linked ?? 0 : null,
							evidence: result !== null && result !== undefined ? result.evidence ?? null : null,
							index: result !== null && result !== undefined ? result.index ?? null : null,
						};
						setResolved({ key: tokenKey, hintKey, items });
					};
					if (missingCount === 0) {
						applyItems(cachedEntries, null);
						return () => { cancelled = true; };
					}
					postJson("/resolve", { cwd, sessionId, texts: missingBold, inlineTexts: missingInline, hints, relativeHints })
						.then(result => {
							if (cancelled || result === null || typeof result !== "object" || result.ok !== true) return;
							const entries = [...cachedEntries];
							for (const item of Array.isArray(result.items) ? result.items : []) {
								if (item === null || typeof item !== "object" || typeof item.text !== "string") continue;
								rememberItem(sessionId, cwd, item.text, item);
								entries.push([item.text, item]);
							}
							applyItems(entries, result);
						})
						.catch(error => {
							if (cancelled) return;
							debug.lastError = String(error && error.message ? error.message : error);
							warnOnce("resolve", `POST ${API_PREFIX}/resolve 失败（消息保持普通加粗）`, error);
						});
					return () => { cancelled = true; };
				}, [tokenKey, hintKey, streaming, props.cwd, resolved]);

				const resolvedItems = resolved !== null && resolved.key === tokenKey && resolved.hintKey === hintKey ? resolved.items : EMPTY_MAP;
				const hits = useMemo(() => linkedHits(resolvedItems), [resolvedItems]);
				const linkedBlocks = (!streaming && ownerReady && hits.size > 0) ? linkifyBlocks(blocks, hits) : blocks;
				const fused = useMemo(
					() => (!streaming && ownerReady && hits.size > 0 ? fuseLineSuffix(linkedBlocks, hits) : { blocks: linkedBlocks, extra: EMPTY_MAP }),
					[linkedBlocks, hits, streaming, ownerReady],
				);
				const displayBlocks = fused.blocks;
				const displayHits = fused.extra.size > 0 ? new Map([...hits, ...fused.extra]) : hits;
				const displayNode = displayBlocks === blocks
					? node
					: { ...node, data: { ...data, blocks: displayBlocks } };

				const baseFileMentions = props !== null && props !== undefined ? props.fileMentions : undefined;
				const fileMentions = useMemo(
					() => composeMentions(baseFileMentions, displayHits, () => props),
					[baseFileMentions, displayHits],
				);

				const stock = getStockAssistantNodeView();
				if (stock === undefined) {
					// Host patch missing: render a readable plain-text fallback instead of a blank row.
					return createElement("div", { "data-dsh-coderef": "missing-stock" },
						displayBlocks.map((block, index) => (block !== null && typeof block === "object" && block.kind === "text")
							? createElement("p", { key: index }, block.text)
							: null));
				}
				return createElement(stock, { ...props, node: displayNode, fileMentions });
			};
		}

		const EMPTY_BLOCKS = Object.freeze([]);
		const EMPTY_CANDIDATES = Object.freeze([]);

		/** Services the client half requires before apply runs. */
		const inject = ["slots"];

		/**
		 * Client half entry.
		 * @param {any} ctx client cordis context
		 */
		function apply(ctx) {
			try {
				if (ctx === undefined || ctx === null) return;
				clientCtx = ctx;
				ensurePingStyle();
				const slots = ctx.slots;
				if (slots === undefined || typeof slots.inject !== "function" || typeof slots.register !== "function") {
					warnOnce("slots", "缺少 slots 服务，coderef 客户端不注册（聊天其余部分不受影响）");
					return;
				}
				const component = createAssistantStep();
				const register = () => slots.register({
					name: "conversation.chat.node",
					key: "assistant-step",
					// Public slot shadowing: a different priority from the shipped
					// occupant is required; the lowest live priority renders.
					priority: -1,
					// Reuse the chat namespace so the shadowed renderer still receives
					// the same locale seat as the stock registration.
					locale: "chat",
				}, component);
				if (typeof ctx.effect === "function") {
					ctx.effect(() => {
						const dispose = slots.inject("conversation.chat.node", register);
						return () => {
							try {
								if (typeof dispose === "function") dispose();
							} catch {
								// ignore
							}
						};
					}, "dsh-coderef: shadow assistant-step");
				} else {
					slots.inject("conversation.chat.node", register);
				}
				console.info(`[${PLUGIN_ID}] client half loaded (v${VERSION}), shadow conversation.chat.node[assistant-step] @ priority -1`);
				// Diagnostic: prove whether the host module table answers the stock renderer
				// require, independent of whether a message has rendered yet.
				setTimeout(() => {
					try {
						const uiChat = require("@deepseek-ai/dsh-client-ui-chat");
						const keys = uiChat !== null && typeof uiChat === "object" ? Object.keys(uiChat).sort() : [];
						debug.requireProbe = { ok: true, hasAssistantNodeView: typeof uiChat.AssistantNodeView === "function", keys };
						console.info(`[${PLUGIN_ID}] require('@deepseek-ai/dsh-client-ui-chat') ok, AssistantNodeView=${typeof uiChat.AssistantNodeView}, exports=${keys.length}`);
					} catch (error) {
						debug.requireProbe = { ok: false, error: String(error && error.message ? error.message : error) };
						console.warn(`[${PLUGIN_ID}] require('@deepseek-ai/dsh-client-ui-chat') failed: ${debug.requireProbe.error}`);
					}
				}, 1500);
			} catch (error) {
				warnOnce("apply", "Client 半挂载失败（GUI 保持可用）", error);
			}
		}

		/** Reset test-only module state. */
		function __resetState() {
			clientCtx = null;
			tokenCache.clear();
			stockCache = undefined;
			debug.stock = "unknown";
			debug.resolves = 0;
			debug.lastError = null;
			debug.lastResolve = null;
			debug.lastPing = null;
			debug.lastOpen = null;
			pingGeneration += 1;
			warned.stock = false;
			warned.resolve = false;
			warned.open = false;
		}

		exports.name = PLUGIN_ID;
		exports.version = VERSION;
		exports.inject = inject;
		exports.apply = apply;
		exports.collectCandidates = collectCandidates;
		exports.collectInlineCandidates = collectInlineCandidates;
		exports.isInlineCandidate = isInlineCandidate;
		exports.fuseLineSuffix = fuseLineSuffix;
		exports.isUsefulCandidate = isUsefulCandidate;
		exports.linkedHits = linkedHits;
		exports.cachedItem = cachedItem;
		exports.rememberItem = rememberItem;
		exports.tokenCache = tokenCache;
		exports.collectHints = collectHints;
		exports.collectRelativePaths = collectRelativePaths;
		exports.resolveCurrentSessionId = resolveCurrentSessionId;
		exports.linkifyBlocks = linkifyBlocks;
		exports.composeMentions = composeMentions;
		exports.hasClosingOwner = hasClosingOwner;
		exports.createAssistantStep = createAssistantStep;
		exports.formatTitle = formatTitle;
		exports.debug = debug;
		exports.pingLine = pingLine;
		exports.findPreviewRows = findPreviewRows;
		exports.ensurePingStyle = ensurePingStyle;
		exports.__resetState = __resetState;
		return module.exports;
	},
});
