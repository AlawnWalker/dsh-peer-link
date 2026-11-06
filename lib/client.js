window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-peer-link",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/PeerListTool.tsx
		/**
		* peer_list 工具的交互式 toolview。
		*
		* 当模型调用 peer_list 后,前端把结果渲染成 peer 卡片列表:
		*   - 按创建时间逆序排序
		*   - 每项显示名字、目录(缩写)、pid、本机标记
		*   - 只显示活跃 peer(后端已过滤)
		*   - 点击 peer 弹窗输入消息,发送后引导模型用 peer_send 转发
		*   - 顶部搜索框可快速筛选
		*
		* 仅从已记录的 tool 调用/结果派生(与 ui-skill 的 SkillRow 一致),保证可重放。
		*/
		/** 从工具结果块提取 peers。优先用 presentationMeta 持久化的 meta。 */
		function peersOf(block) {
			if (!("kind" in block)) return [];
			const meta = block.meta;
			if (meta && Array.isArray(meta.peers)) return meta.peers;
			for (const item of block.content) {
				if (item.type !== "text") continue;
				try {
					const parsed = JSON.parse(item.text);
					if (Array.isArray(parsed.peers)) return parsed.peers;
				} catch {}
			}
			return [];
		}
		/** 解析创建时间戳(ms)用于排序。返回 number 或 0。 */
		function timeMs(peer) {
			if (!peer.time) return 0;
			const t = Date.parse(peer.time);
			return Number.isNaN(t) ? 0 : t;
		}
		/** 相对时间:"刚刚" / "X分钟前" / "X小时前" / 具体日期。 */
		function relativeTime(timeStr) {
			if (!timeStr) return "";
			const t = Date.parse(timeStr);
			if (Number.isNaN(t)) return timeStr.slice(5, 16);
			const diff = Date.now() - t;
			const min = Math.floor(diff / 6e4);
			if (min < 1) return "刚刚";
			if (min < 60) return `${min}分钟前`;
			const hr = Math.floor(min / 60);
			if (hr < 24) return `${hr}小时前`;
			const day = Math.floor(hr / 24);
			if (day < 7) return `${day}天前`;
			return timeStr.slice(0, 10);
		}
		/** 目录缩写:取最后 1-2 段,超长省略中间。 */
		function shortCwd(cwd) {
			if (!cwd) return "?";
			const parts = cwd.split("/").filter(Boolean);
			if (parts.length <= 2) return cwd;
			return `…/${parts.slice(-2).join("/")}`;
		}
		/** 内联样式(避免 CSS 模块构建链)。 */
		const styles = {
			card: {
				border: "1px solid var(--dsw-alias-border-l2, #d0d7de)",
				borderRadius: 10,
				padding: "6px 0",
				maxHeight: 400,
				overflowY: "auto",
				display: "flex",
				flexDirection: "column"
			},
			header: {
				padding: "6px 12px 8px",
				borderBottom: "1px solid var(--dsw-alias-border-l1, #eef1f4)"
			},
			headerRow: {
				display: "flex",
				alignItems: "center",
				gap: 8,
				marginBottom: 6
			},
			hint: {
				fontSize: 11,
				color: "var(--dsw-alias-label-tertiary, #57606a)"
			},
			searchWrap: {
				position: "relative",
				display: "flex",
				alignItems: "center"
			},
			searchInput: {
				width: "100%",
				padding: "5px 10px",
				border: "1px solid var(--dsw-alias-border-l2, #d0d7de)",
				borderRadius: 6,
				fontSize: 12,
				background: "transparent",
				color: "inherit",
				outline: "none"
			},
			list: {
				flex: 1,
				overflowY: "auto"
			},
			row: {
				display: "flex",
				alignItems: "center",
				gap: 8,
				padding: "7px 12px",
				cursor: "pointer",
				border: "none",
				background: "transparent",
				width: "100%",
				textAlign: "left",
				fontSize: 13,
				lineHeight: 1.4,
				color: "inherit"
			},
			rowHover: { background: "var(--dsw-alias-interactive-bg-hover, #f6f8fa)" },
			name: {
				fontWeight: 600,
				flex: "none"
			},
			cwd: {
				color: "var(--dsw-alias-label-tertiary, #57606a)",
				fontSize: 11,
				flex: "none",
				maxWidth: 160,
				overflow: "hidden",
				textOverflow: "ellipsis",
				whiteSpace: "nowrap"
			},
			time: {
				color: "var(--dsw-alias-label-tertiary, #57606a)",
				fontSize: 11,
				flex: "none"
			},
			selfTag: {
				background: "var(--dsw-alias-state-info-bg, #ddf4ff)",
				color: "var(--dsw-alias-state-info-primary, #0969da)",
				borderRadius: 6,
				padding: "0 5px",
				fontSize: 10,
				flex: "none"
			},
			empty: {
				padding: "14px 12px",
				fontSize: 12,
				color: "var(--dsw-alias-label-tertiary, #57606a)",
				textAlign: "center"
			},
			modalBody: {
				display: "flex",
				flexDirection: "column",
				gap: 10,
				minWidth: 320
			},
			modalTarget: {
				fontSize: 12,
				color: "var(--dsw-alias-label-secondary, #57606a)"
			},
			modalInput: {
				width: "100%",
				padding: "8px 10px",
				border: "1px solid var(--dsw-alias-border-l2, #d0d7de)",
				borderRadius: 6,
				fontSize: 13,
				background: "transparent",
				color: "inherit",
				outline: "none",
				fontFamily: "inherit",
				resize: "vertical",
				minHeight: 70
			},
			modalFooter: {
				display: "flex",
				gap: 8,
				justifyContent: "flex-end"
			},
			status: {
				fontSize: 11,
				padding: "4px 12px",
				color: "var(--dsw-alias-state-info-primary, #0969da)"
			}
		};
		/**
		* 渲染 peer 列表卡片(可交互)。
		* @param props - toolview 运行时 props + inject 注入的 onSend。
		*/
		function PeerListTool(props) {
			const { block, onSend, onRefresh } = props;
			const peers = (0, react.useMemo)(() => peersOf(block), [block]);
			const sorted = (0, react.useMemo)(() => [...peers].sort((a, b) => timeMs(b) - timeMs(a)), [peers]);
			const [query, setQuery] = (0, react.useState)("");
			const [compose, setCompose] = (0, react.useState)(null);
			const [message, setMessage] = (0, react.useState)("");
			const [hoverPid, setHoverPid] = (0, react.useState)(void 0);
			const [sent, setSent] = (0, react.useState)(null);
			const [refreshing, setRefreshing] = (0, react.useState)(false);
			const doRefresh = () => {
				setRefreshing(true);
				onRefresh?.();
				setTimeout(() => setRefreshing(false), 3e3);
			};
			const filtered = (0, react.useMemo)(() => {
				if (!query.trim()) return sorted;
				const q = query.trim().toLowerCase();
				return sorted.filter((p) => p.name.toLowerCase().includes(q) || (p.cwd ?? "").toLowerCase().includes(q));
			}, [sorted, query]);
			const openCompose = (peer) => {
				if (peer.self === true) {
					setSent("这是当前会话,不能给自己发消息。选择其他 peer 发送。");
					return;
				}
				setCompose(peer);
				setMessage("");
				setSent(null);
			};
			const doSend = () => {
				if (!compose || !message.trim()) return;
				onSend?.(compose.name, message.trim());
				setSent(`已提交给模型,将用 peer_send 转发给 ${compose.name}`);
				setCompose(null);
				setMessage("");
			};
			if (peers.length === 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: styles.card,
				"data-peer-list-tool": true,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					style: styles.empty,
					children: "暂无活跃 peer"
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					style: {
						padding: "8px 12px",
						display: "flex",
						justifyContent: "center"
					},
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						onClick: doRefresh,
						disabled: refreshing,
						style: {
							fontSize: 12,
							padding: "5px 14px",
							border: "1px solid var(--dsw-alias-border-l2, #d0d7de)",
							borderRadius: 6,
							background: "transparent",
							cursor: refreshing ? "default" : "pointer",
							color: "inherit"
						},
						children: refreshing ? "刷新中…" : "🔄 刷新"
					})
				})]
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: styles.card,
				"data-peer-list-tool": true,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: styles.header,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: styles.headerRow,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									style: styles.hint,
									children: [
										"活跃 peers ",
										peers.length,
										" 个(最新在前)"
									]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { style: { flex: 1 } }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									onClick: doRefresh,
									disabled: refreshing,
									style: {
										fontSize: 11,
										padding: "3px 8px",
										border: "1px solid var(--dsw-alias-border-l2, #d0d7de)",
										borderRadius: 6,
										background: "transparent",
										color: refreshing ? "var(--dsw-alias-label-tertiary, #57606a)" : "inherit",
										cursor: refreshing ? "default" : "pointer"
									},
									title: "重新调用 peer_list 刷新列表",
									children: refreshing ? "刷新中…" : "🔄 刷新"
								})
							]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: styles.searchWrap,
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								style: styles.searchInput,
								placeholder: "🔍 搜索名字或目录…",
								value: query,
								onChange: (e) => setQuery(e.currentTarget.value)
							})
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: styles.list,
						children: [filtered.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: styles.empty,
							children: "无匹配 peer"
						}), filtered.map((peer) => {
							const isHover = hoverPid === peer.pid;
							return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: { borderTop: "1px solid var(--dsw-alias-border-l1, #f6f8fa)" },
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
									type: "button",
									style: {
										...styles.row,
										...isHover ? styles.rowHover : {},
										flexDirection: "column",
										alignItems: "stretch",
										gap: 2
									},
									onMouseEnter: () => setHoverPid(peer.pid),
									onMouseLeave: () => setHoverPid(void 0),
									onClick: () => openCompose(peer),
									title: `${peer.name} — ${peer.cwd ?? ""}`,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										style: {
											display: "flex",
											alignItems: "center",
											gap: 8
										},
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												style: {
													width: 8,
													height: 8,
													borderRadius: "50%",
													background: "var(--dsw-alias-state-success-primary, #1a7f37)",
													flex: "none",
													display: "inline-block"
												},
												title: "在线"
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												style: styles.name,
												children: peer.name
											}),
											peer.self === true && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												style: styles.selfTag,
												children: "当前会话"
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { style: { flex: 1 } }),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												style: styles.cwd,
												children: shortCwd(peer.cwd)
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												style: styles.time,
												children: relativeTime(peer.time)
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												style: {
													fontSize: 12,
													color: isHover ? "var(--dsw-alias-state-info-primary, #0969da)" : "transparent"
												},
												children: "✉️"
											})
										]
									}), peer.preview !== void 0 && peer.preview !== "" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										style: {
											paddingLeft: 16,
											fontSize: 11,
											color: "var(--dsw-alias-label-tertiary, #57606a)",
											overflow: "hidden",
											textOverflow: "ellipsis",
											whiteSpace: "nowrap"
										},
										children: ["💬 ", peer.preview]
									})]
								})
							}, peer.pid);
						})]
					}),
					sent !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: styles.status,
						children: ["✓ ", sent]
					}),
					compose !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Modal, {
						open: true,
						onClose: () => setCompose(null),
						title: `发送消息给 ${compose.name}`,
						closeLabel: "关闭",
						description: compose.cwd ?? "",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: styles.modalBody,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: styles.modalTarget,
									children: [
										"收件人: ",
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: compose.name }),
										" (pid ",
										compose.pid,
										")",
										compose.self === true ? " · 当前会话" : ""
									]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
									style: styles.modalInput,
									value: message,
									onChange: (e) => setMessage(e.currentTarget.value),
									placeholder: "输入要发送的消息…",
									autoFocus: true
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: styles.modalFooter,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
										variant: "ghost",
										onClick: () => setCompose(null),
										children: "取消"
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
										variant: "primary",
										disabled: !message.trim(),
										onClick: doSend,
										children: "发送"
									})]
								})
							]
						})
					})
				]
			});
		}
		//#endregion
		//#region src/client/index.ts
		/** 需要的 client 服务。 */
		const inject = [
			"slots",
			"connection",
			"sessions"
		];
		/**
		* 注册 peer_list 的自定义 toolview。
		* @param ctx - client root context。
		*/
		function apply(ctx) {
			ctx.effect(() => {
				const connection = ctx.get("connection");
				const sessions = ctx.get("sessions");
				const promptCurrent = (instruction) => {
					const current = sessions.list.getSnapshot().current;
					if (!current) {
						console.warn("[peer-link] 无当前会话,无法发送");
						return;
					}
					const content = [{
						type: "text",
						text: instruction
					}];
					connection.api.sessions.prompt({
						sessionId: current,
						mode: "queue",
						content
					}).catch((e) => {
						console.error("[peer-link] 提交指令失败:", e);
					});
				};
				const onSend = (target, text) => {
					promptCurrent(`请用 peer_send 工具向 peer「${target}」发送消息:\n\n${text}`);
				};
				const onRefresh = () => {
					promptCurrent("请重新调用 peer_list 工具,刷新活跃 peer 列表。");
				};
				const dispose = ctx.slots.register({
					name: "tool.call.toolview",
					key: "peer_list",
					inject: () => ({
						onSend,
						onRefresh
					})
				}, PeerListTool);
				return () => dispose();
			}, "peer-link: peer_list toolview");
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map