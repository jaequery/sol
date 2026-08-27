# Generates the hi-fi UX walkthrough as static HTML using SolCut's real design tokens.
import html, io, pathlib

TOKENS = pathlib.Path("src/styles/tokens.css").read_text()

CSS = TOKENS + """
*,*::before,*::after{box-sizing:border-box}
body{margin:0;background:#05060a;color:var(--ink);font-family:var(--font);font-size:var(--fs-md);-webkit-font-smoothing:antialiased}
.page{max-width:1180px;margin:0 auto;padding:32px 20px 80px}
h1{font-size:26px;font-weight:700;letter-spacing:-.025em;margin:0 0 6px}
.lede{color:var(--ink-3);font-size:13.5px;line-height:1.65;max-width:74ch;margin:0 0 10px}
.kicker{display:inline-block;font:600 10px/1 var(--mono);letter-spacing:.12em;text-transform:uppercase;color:var(--accent-2);
  border:1px solid var(--accent-line);background:var(--accent-wash);padding:5px 9px;border-radius:var(--r-sm);margin-bottom:14px}
.toc{display:flex;flex-wrap:wrap;gap:6px;margin:18px 0 34px;padding:14px;border:1px solid var(--line);border-radius:var(--r-md);background:var(--panel)}
.toc a{font-size:11.5px;color:var(--ink-2);text-decoration:none;border:1px solid var(--line);background:var(--sunken);padding:5px 9px;border-radius:99px}
.toc a:hover{color:var(--ink);border-color:var(--accent-line)}
.act{margin:44px 0 18px;padding-bottom:10px;border-bottom:1px solid var(--line);display:flex;align-items:baseline;gap:10px}
.act h2{margin:0;font-size:15px;font-weight:650;letter-spacing:-.01em}
.act span{font:600 10px/1 var(--mono);letter-spacing:.1em;text-transform:uppercase;color:var(--ink-3)}
figure{margin:0 0 34px}
.stepno{display:flex;align-items:center;gap:9px;margin-bottom:9px}
.stepno b{width:22px;height:22px;border-radius:6px;background:var(--accent-dim);border:1px solid var(--accent-line);color:var(--accent-2);
  display:grid;place-items:center;font:700 10.5px/1 var(--mono)}
.stepno .t{font-size:13px;font-weight:650}
.stepno .s{margin-left:auto;font:600 9.5px/1 var(--mono);letter-spacing:.08em;text-transform:uppercase;padding:4px 8px;border-radius:99px;
  border:1px solid var(--line);color:var(--ink-3);background:var(--sunken)}
.s.ok{color:var(--ok);border-color:#14503c;background:#08211a}
.s.run{color:var(--accent-2);border-color:var(--accent-line);background:var(--accent-wash)}
.s.err{color:var(--err);border-color:#5c2036;background:var(--err-wash)}
.s.warn{color:var(--warn);border-color:#5a4212;background:#241c06}
figcaption{margin-top:10px;font-size:12.5px;line-height:1.6;color:var(--ink-2);border-left:2px solid var(--accent-line);padding-left:11px}
figcaption b{color:var(--ink);font-weight:600}

/* ---------- app shell ---------- */
.app{background:var(--bg);border:1px solid var(--line);border-radius:var(--r-lg);overflow:hidden;box-shadow:var(--shadow);position:relative}
.titlebar{height:var(--h-titlebar);display:flex;align-items:center;gap:10px;padding:0 12px;
  background:linear-gradient(180deg,#171a28,#101220);border-bottom:1px solid var(--line)}
.dots{display:flex;gap:6px}.dots i{width:11px;height:11px;border-radius:50%;display:block}
.dots i:nth-child(1){background:#ff5f57}.dots i:nth-child(2){background:#febc2e}.dots i:nth-child(3){background:#28c840}
.doc{font-size:var(--fs);color:var(--ink-2)}.doc b{color:var(--ink);font-weight:600}
.tb-right{margin-left:auto;display:flex;gap:8px;align-items:center}
.btn{border:1px solid var(--line);background:var(--panel-2);color:var(--ink);border-radius:var(--r-sm);padding:6px 12px;font-size:var(--fs);font-weight:550}
.btn.primary{background:linear-gradient(180deg,var(--accent),#6a4ae0);border-color:#8b6bff}
.btn.ghost{background:transparent}
.btn.dis{opacity:.42}
.chip-run{display:flex;align-items:center;gap:6px;font:600 10px/1 var(--mono);color:var(--accent-2);
  border:1px solid var(--accent-line);background:var(--accent-wash);padding:5px 8px;border-radius:99px}

.body{display:grid;grid-template-columns:var(--w-bin) 1fr var(--w-inspector);height:378px}
.col{min-width:0;display:flex;flex-direction:column}
.col+.col{border-left:1px solid var(--line)}
.hd{height:var(--h-panelhead);display:flex;align-items:center;gap:8px;padding:0 12px;border-bottom:1px solid var(--line);
  font:600 var(--fs-sm)/1 var(--font);letter-spacing:.06em;text-transform:uppercase;color:var(--ink-3);background:var(--chrome)}
.hd .r{margin-left:auto;text-transform:none;letter-spacing:0;font-weight:500;color:var(--ink-3)}

.bin{padding:10px;display:grid;grid-template-columns:1fr 1fr;gap:8px;overflow:hidden;background:var(--panel);align-content:start}
.thumb{position:relative;aspect-ratio:16/10;border-radius:var(--r);overflow:hidden;border:1px solid var(--line)}
.thumb .t{position:absolute;inset:0}
.thumb .lbl{position:absolute;left:5px;bottom:5px;font:600 9px/1 var(--mono);background:rgba(6,7,12,.8);
  border:1px solid rgba(255,255,255,.09);padding:3px 5px;border-radius:4px;color:#dfe3f4;max-width:calc(100% - 10px);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.thumb .kind{position:absolute;right:5px;top:5px;width:16px;height:16px;border-radius:4px;background:rgba(6,7,12,.8);
  display:grid;place-items:center;font-size:9px;border:1px solid rgba(255,255,255,.09)}
.skel{position:relative;aspect-ratio:16/10;border-radius:var(--r);border:1px solid var(--line);
  background:linear-gradient(100deg,#171a27 30%,#22263a 50%,#171a27 70%)}
.bin-empty{grid-column:1/-1;border:1.5px dashed var(--line);border-radius:var(--r-md);padding:20px 12px;text-align:center;color:var(--ink-3);font-size:11.5px;line-height:1.6}
.bin-empty b{display:block;color:var(--ink-2);font-size:12px;margin-bottom:4px}
.bin-err{grid-column:1/-1;border:1px solid #5c2036;background:var(--err-wash);border-radius:var(--r);padding:8px 9px;font-size:10.5px;line-height:1.5;color:#ffc2cf}
.bin-err b{display:block;color:var(--err);font-weight:650;margin-bottom:2px}

.stage{flex:1;display:grid;place-items:center;background:radial-gradient(120% 90% at 50% 0%,#151827,#0a0b12);padding:16px;position:relative}
.canvas{width:100%;max-width:452px;aspect-ratio:16/9;border-radius:var(--r-md);position:relative;overflow:hidden;
  border:1px solid #2c3149;box-shadow:var(--shadow)}
.canvas .img{position:absolute;inset:0}
.framebox{position:absolute;inset:18% 14%;border:1.5px dashed rgba(167,139,250,.85);border-radius:4px}
.framebox::after{content:"";position:absolute;right:-5px;bottom:-5px;width:9px;height:9px;background:var(--accent-2);border-radius:2px}
.hud{position:absolute;left:10px;top:10px;display:flex;gap:6px;align-items:center;background:rgba(8,9,16,.74);
  border:1px solid rgba(255,255,255,.1);border-radius:var(--r-sm);padding:5px 8px;font:600 10px/1 var(--mono);color:#cfd5ee}
.dia{width:8px;height:8px;background:var(--accent-2);transform:rotate(45deg);border-radius:1px;display:block}
.badge-ai{position:absolute;right:10px;top:10px;display:flex;gap:5px;align-items:center;background:rgba(124,92,255,.9);
  border:1px solid rgba(255,255,255,.25);border-radius:99px;padding:4px 9px;font:700 9.5px/1 var(--mono);letter-spacing:.06em;color:#fff}
.stage-empty{text-align:center;color:var(--ink-3);font-size:12.5px;line-height:1.7;max-width:300px}
.stage-empty .ic{font-size:30px;opacity:.35;margin-bottom:10px}
.stage-empty b{display:block;color:var(--ink-2);font-size:13px;margin-bottom:5px}
.offline{position:absolute;inset:0;display:grid;place-items:center;background:repeating-linear-gradient(135deg,#16151c 0 10px,#1c1a24 10px 20px);
  color:var(--warn);font:600 11px/1.6 var(--mono);text-align:center}

.transport{height:var(--h-transport);display:flex;align-items:center;gap:14px;justify-content:center;border-top:1px solid var(--line);background:var(--chrome)}
.tbtn{width:28px;height:28px;border-radius:var(--r-sm);border:1px solid var(--line);background:var(--panel-2);display:grid;place-items:center;color:var(--ink-2);font-size:11px}
.tbtn.play{background:var(--ink);color:var(--bg);border-color:var(--ink);width:32px;height:32px}
.tc{font:600 var(--fs-sm)/1 var(--mono);color:var(--ink-2);letter-spacing:.04em}
.tc.dim{color:#4b5170}

.insp{padding:12px;overflow:hidden;background:var(--panel);display:flex;flex-direction:column;gap:12px}
.card{border:1px solid var(--line);border-radius:var(--r-md);background:var(--panel-2);overflow:hidden}
.card.ai{border-color:#3a2f6b}
.card.err{border-color:#5c2036}
.card .ch{display:flex;align-items:center;gap:8px;padding:9px 11px;border-bottom:1px solid var(--line);font-size:var(--fs);font-weight:600}
.card.ai .ch{background:var(--accent-wash);border-color:#3a2f6b}
.card.err .ch{background:var(--err-wash);border-color:#5c2036;color:#ffc2cf}
.card .cb{padding:11px}
.card.off{opacity:.45}
.row{display:flex;align-items:center;justify-content:space-between;gap:9px;padding:5px 0}
.row label{color:var(--ink-2);font-size:11.5px;flex:0 0 auto}
.num{font:600 var(--fs-sm)/1 var(--mono);background:var(--sunken);border:1px solid var(--line);border-radius:var(--r-sm);padding:5px 7px;min-width:56px;text-align:right}
.slider{height:4px;border-radius:3px;background:var(--sunken);position:relative;flex:1;border:1px solid var(--line)}
.slider i{position:absolute;left:0;top:-1px;bottom:-1px;background:linear-gradient(90deg,#5b40d6,var(--accent-2));border-radius:3px}
.slider b{position:absolute;top:50%;transform:translate(-50%,-50%);width:11px;height:11px;border-radius:50%;background:#fff}
.ta{width:100%;min-height:64px;background:var(--sunken);border:1px solid #33305e;border-radius:var(--r);color:var(--ink);
  padding:9px;font-size:var(--fs);line-height:1.55;overflow:hidden}
.ta.ph{color:var(--ink-3)}
.ta.scroll{max-height:64px;overflow:hidden;position:relative}
.ta.scroll::after{content:"";position:absolute;left:0;right:0;bottom:0;height:22px;background:linear-gradient(180deg,transparent,var(--sunken))}
.chips{display:flex;flex-wrap:wrap;gap:5px;margin-top:8px}
.chip{font-size:10.5px;color:var(--ink-2);border:1px solid var(--line);background:var(--sunken);border-radius:99px;padding:4px 8px}
.gen{width:100%;margin-top:10px;padding:9px;border-radius:var(--r);border:1px solid #8b6bff;color:#fff;font-weight:650;font-size:var(--fs);
  background:linear-gradient(180deg,var(--accent),#6a4ae0);text-align:center}
.gen.dis{opacity:.4;background:var(--panel-2);border-color:var(--line);color:var(--ink-3)}
.gen.danger{background:linear-gradient(180deg,#e05570,#c33a56);border-color:#ff7d96}
.hint{font-size:11px;color:var(--ink-3);margin-top:7px;line-height:1.5}
.hint.err{color:#ffb3c2}
.callout{border:1px solid #5a4212;background:#241c06;border-radius:var(--r);padding:9px;font-size:11px;line-height:1.55;color:#ffe0a3}
.callout b{display:block;color:var(--warn);margin-bottom:3px}
.callout .a{display:inline-block;margin-top:7px;color:var(--warn);border:1px solid #5a4212;border-radius:var(--r-sm);padding:4px 8px;font-weight:600}
.insp-empty{margin:auto;text-align:center;color:var(--ink-3);font-size:11.5px;line-height:1.7;padding:0 8px}
.insp-empty .ic{font-size:22px;opacity:.35;margin-bottom:8px}
.insp-empty b{display:block;color:var(--ink-2);font-size:12px;margin-bottom:4px}
.pbar{height:4px;border-radius:3px;background:var(--sunken);border:1px solid var(--line);position:relative;overflow:hidden;margin-top:8px}
.pbar i{position:absolute;left:0;top:0;bottom:0;background:linear-gradient(90deg,#5b40d6,var(--accent-2));border-radius:3px}
.kv{display:flex;justify-content:space-between;font-size:11px;color:var(--ink-3);padding:4px 0}
.kv b{font:600 10.5px/1 var(--mono);color:var(--ink-2)}
.btn-row{display:flex;gap:6px;margin-top:9px}
.btn-row .b{flex:1;text-align:center;font-size:11.5px;font-weight:600;border:1px solid var(--line);background:var(--sunken);border-radius:var(--r-sm);padding:7px}
.btn-row .b.pri{border-color:#8b6bff;background:linear-gradient(180deg,var(--accent),#6a4ae0);color:#fff}

/* ---------- timeline ---------- */
.tl{border-top:1px solid var(--line);background:#0d0f18;position:relative}
.tlbar{height:var(--h-toolbar);display:flex;align-items:center;gap:8px;padding:0 12px;border-bottom:1px solid var(--line)}
.tool{width:26px;height:22px;border-radius:var(--r-sm);border:1px solid var(--line);background:var(--panel-2);display:grid;place-items:center;font-size:11px;color:var(--ink-2)}
.tool.on{background:var(--accent-dim);border-color:var(--accent-line);color:#cbbcff}
.tool.wide{width:auto;padding:0 9px;font-weight:600;font-size:11px}
.tool.dis{opacity:.4}
.zoom{margin-left:auto;display:flex;align-items:center;gap:7px;color:var(--ink-3);font:600 10px/1 var(--mono)}
.zbar{width:78px;height:3px;background:#191c2a;border-radius:2px;position:relative}
.zbar i{position:absolute;left:0;top:0;bottom:0;background:var(--ink-3);border-radius:2px}
.ruler{height:var(--h-ruler);position:relative;border-bottom:1px solid var(--line);background:#0a0c14;overflow:hidden}
.ruler span{position:absolute;top:5px;font:600 9px/1 var(--mono);color:var(--ink-3)}
.ruler i{position:absolute;top:0;bottom:0;width:1px;background:var(--line-soft)}
.track{position:relative;height:92px;padding:10px 0 0}
.clips{position:relative;height:62px;margin:0 12px}
.clip{position:absolute;top:0;bottom:0;border-radius:var(--r);overflow:hidden;border:1px solid rgba(255,255,255,.1)}
.clip .fill{position:absolute;inset:0;opacity:.92}
.clip .strip{position:absolute;inset:0;display:flex}
.clip .strip div{flex:1;border-right:1px solid rgba(0,0,0,.25)}
.clip .name{position:absolute;left:7px;top:6px;right:36px;font:600 10px/1 var(--font);color:#fff;text-shadow:0 1px 3px rgba(0,0,0,.7);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.clip .dur{position:absolute;right:7px;bottom:6px;font:600 9px/1 var(--mono);color:rgba(255,255,255,.85);text-shadow:0 1px 3px rgba(0,0,0,.7)}
.clip.sel{border-color:var(--accent-2);box-shadow:0 0 0 1px var(--accent-2),0 6px 22px rgba(124,92,255,.35)}
.clip.ai{border-color:#8b6bff}
.clip .aitag{position:absolute;left:7px;bottom:6px;font:700 8.5px/1 var(--mono);letter-spacing:.08em;background:rgba(124,92,255,.92);
  border:1px solid rgba(255,255,255,.25);color:#fff;padding:3px 5px;border-radius:4px}
.clip .grip{position:absolute;top:0;bottom:0;width:7px;background:rgba(0,0,0,.35);display:grid;place-items:center}
.clip .grip.l{left:0}.clip .grip.r{right:0}
.clip .grip b{width:2px;height:16px;background:rgba(255,255,255,.6);border-radius:2px;display:block}
.clip.gone{border-color:#5a4212;background:repeating-linear-gradient(135deg,#16151c 0 9px,#1f1c26 9px 18px)}
.clip .gonetag{position:absolute;inset:0;display:grid;place-items:center;font:600 9.5px/1 var(--mono);color:var(--warn)}
.kflane{position:absolute;left:0;right:0;bottom:0;height:20px;background:linear-gradient(180deg,rgba(6,7,12,.12),rgba(6,7,12,.85))}
.kf{position:absolute;bottom:5px;width:10px;height:10px;background:#fff;border:1.5px solid var(--accent);transform:translateX(-50%) rotate(45deg);border-radius:2px}
.kf.on{background:var(--accent-2);border-color:#fff}
.kfcluster{position:absolute;bottom:4px;transform:translateX(-50%);font:700 8px/1 var(--mono);background:var(--accent);color:#fff;
  border:1px solid #fff;border-radius:99px;padding:3px 5px}
.seg{position:absolute;bottom:9px;height:2px;background:repeating-linear-gradient(90deg,var(--accent-2) 0 5px,transparent 5px 9px);border-radius:2px}
.seg.solid{background:var(--accent-2)}
.segpill{position:absolute;bottom:24px;transform:translateX(-50%);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:210px;
  font:600 9px/1 var(--font);background:rgba(124,92,255,.9);color:#fff;padding:4px 7px;border-radius:99px;border:1px solid rgba(255,255,255,.25)}
.kfhint{position:absolute;left:50%;bottom:4px;transform:translateX(-50%);font:600 9px/1 var(--mono);color:rgba(255,255,255,.55)}
.genclip{position:absolute;top:0;bottom:0;border-radius:var(--r);border:1.5px dashed #6f5bd6;
  background:repeating-linear-gradient(135deg,#1b1738 0 10px,#221c48 10px 20px);
  display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5px;color:#cbbcff;font:600 10px/1 var(--font);padding:0 8px}
.genclip.err{border-color:#a13a55;background:repeating-linear-gradient(135deg,#241019 0 10px,#2e1420 10px 20px);color:#ffb3c2}
.genclip .mini{width:70%;height:3px;background:rgba(255,255,255,.14);border-radius:3px;position:relative;overflow:hidden}
.genclip .mini i{position:absolute;left:0;top:0;bottom:0;background:linear-gradient(90deg,#5b40d6,var(--accent-2));border-radius:3px}
.genclip .sub{font:600 8.5px/1 var(--mono);opacity:.8}
.ghost{position:absolute;top:0;bottom:0;border-radius:var(--r);border:1.5px dashed var(--accent);background:rgba(124,92,255,.13)}
.playhead{position:absolute;top:0;bottom:0;width:2px;background:var(--playhead);z-index:6}
.playhead::before{content:"";position:absolute;top:-1px;left:50%;transform:translateX(-50%);border-left:6px solid transparent;border-right:6px solid transparent;border-top:8px solid var(--playhead)}
.dropzone{position:absolute;inset:10px 12px 8px;border:1.5px dashed var(--line);border-radius:var(--r-md);display:grid;place-items:center;
  text-align:center;color:var(--ink-3);font-size:11.5px;line-height:1.6}
.dropzone.hot{border-color:var(--accent);background:rgba(124,92,255,.1);color:#cbbcff}
.dropzone b{display:block;color:var(--ink-2);font-size:12px;margin-bottom:3px}
.dropzone.hot b{color:#dcd3ff}
.insert{position:absolute;top:6px;bottom:6px;width:3px;background:var(--accent);border-radius:2px;box-shadow:0 0 12px rgba(124,92,255,.9)}
.dragbadge{position:absolute;right:16px;top:-26px;font:700 9.5px/1 var(--mono);background:var(--accent);color:#fff;border-radius:99px;padding:5px 9px;border:1px solid #a78bfa}
.scrollbar{position:absolute;left:12px;right:12px;bottom:3px;height:4px;background:#151827;border-radius:3px}
.scrollbar i{position:absolute;top:0;bottom:0;background:#39405c;border-radius:3px}

/* ---------- overlays ---------- */
.scrim{position:absolute;inset:0;background:rgba(4,5,10,.72);display:grid;place-items:center;z-index:20}
.modal{width:392px;background:var(--panel);border:1px solid var(--line);border-radius:var(--r-lg);box-shadow:var(--shadow-pop);overflow:hidden}
.modal .mh{padding:13px 15px;border-bottom:1px solid var(--line);font-size:var(--fs-md);font-weight:650;display:flex;align-items:center;gap:8px}
.modal .mb{padding:15px;display:flex;flex-direction:column;gap:11px}
.modal .mf{padding:12px 15px;border-top:1px solid var(--line);display:flex;gap:8px;justify-content:flex-end;background:var(--chrome)}
.field label{display:block;font-size:11px;color:var(--ink-2);margin-bottom:5px;font-weight:550}
.input{background:var(--sunken);border:1px solid var(--line);border-radius:var(--r);padding:8px 10px;font:500 12px/1 var(--mono);color:var(--ink)}
.input.ph{color:var(--ink-3)}
.input.bad{border-color:#5c2036}
.stagelist{display:flex;flex-direction:column;gap:8px}
.stagerow{display:flex;align-items:center;gap:9px;font-size:11.5px;color:var(--ink-2)}
.stagerow .d{width:15px;height:15px;border-radius:50%;border:1.5px solid var(--line);display:grid;place-items:center;font-size:8px;color:var(--ink-3);flex:0 0 auto}
.stagerow.done .d{background:var(--ok);border-color:var(--ok);color:#052e22}
.stagerow.now .d{border-color:var(--accent-2);color:var(--accent-2)}
.stagerow.now{color:var(--ink)}
.errbox{border:1px solid #5c2036;background:var(--err-wash);border-radius:var(--r);padding:10px;font-size:11.5px;line-height:1.6;color:#ffc2cf}
.errbox b{display:block;color:var(--err);margin-bottom:4px;font-weight:650}
.errbox code{display:block;margin-top:7px;font:500 10px/1.5 var(--mono);background:#170a11;border:1px solid #40182a;border-radius:5px;padding:7px;color:#ffa8bb;white-space:pre-wrap}
.toast{position:absolute;right:16px;bottom:16px;z-index:20;display:flex;align-items:center;gap:10px;background:var(--panel-2);
  border:1px solid var(--line);border-radius:var(--r-md);padding:11px 13px;box-shadow:var(--shadow-pop);max-width:330px}
.toast .ic{width:24px;height:24px;border-radius:7px;display:grid;place-items:center;font-size:12px;flex:0 0 auto}
.toast.ok .ic{background:#08211a;border:1px solid #14503c;color:var(--ok)}
.toast .tx{font-size:11.5px;line-height:1.5;min-width:0}
.toast .tx b{display:block;font-size:12px;font-weight:650;margin-bottom:2px}
.toast .tx span{color:var(--ink-3);font:500 10px/1.4 var(--mono);display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.toast .a{margin-left:auto;font-size:11px;font-weight:600;color:var(--accent-2);border:1px solid var(--accent-line);border-radius:var(--r-sm);padding:5px 8px;flex:0 0 auto}

/* gradients standing in for real media */
.g1{background:linear-gradient(135deg,#f6c17c,#e2688f 55%,#7b4bd6)}
.g2{background:linear-gradient(135deg,#7ee0d5,#3d8bd8 60%,#26307a)}
.g3{background:linear-gradient(160deg,#2a3550,#5c7fb8 45%,#c9dbf2)}
.g4{background:linear-gradient(135deg,#ffd6a5,#ff8fa3 50%,#b06ab3)}
.g5{background:linear-gradient(200deg,#0f2027,#2c5364 60%,#7ea8c4)}
.g6{background:linear-gradient(135deg,#3a1c71,#d76d77 55%,#ffaf7b)}
"""

# ---------------------------------------------------------------- shell helpers
BIN_DEFAULT = [("g1","▣","sunset.jpg"),("g2","▶","surf.mp4"),("g3","▣","cliff.png"),
               ("g4","▣","market.jpg"),("g5","▶","drive.mov"),("g6","▣","neon.jpg")]

def bin_html(items=None, skeletons=0, empty=False, error=None):
    if empty:
        return ('<div class="bin"><div class="bin-empty"><b>No media yet</b>'
                'Drop photos and videos anywhere,<br>or click Import.</div></div>')
    out = ['<div class="bin">']
    if error:
        out.append(f'<div class="bin-err"><b>Could not import 1 file</b>{html.escape(error)}</div>')
    for g,k,n in (items if items is not None else BIN_DEFAULT):
        out.append(f'<div class="thumb"><div class="t {g}"></div><div class="kind">{k}</div>'
                   f'<div class="lbl">{html.escape(n)}</div></div>')
    out += ['<div class="skel"></div>'] * skeletons
    out.append('</div>')
    return "".join(out)

def stage_html(inner):
    return f'<div class="stage">{inner}</div>'

def canvas(grad="g1", scale=1.14, tx="-3%", ty="2%", framebox=True, hud=None, aitag=False, offline=False):
    bits = [f'<div class="img {grad}" style="transform:scale({scale}) translate({tx},{ty})"></div>']
    if offline:
        bits = ['<div class="offline">MEDIA OFFLINE<br><span style="opacity:.7">sunset.jpg was moved or deleted</span></div>']
    else:
        if framebox: bits.append('<div class="framebox"></div>')
        if hud: bits.append(f'<div class="hud"><span class="dia"></span> {hud}</div>')
        if aitag: bits.append('<div class="badge-ai">✦ AI GENERATED</div>')
    return f'<div class="canvas">{"".join(bits)}</div>'

def stage_empty():
    return ('<div class="stage-empty"><div class="ic">🎞</div><b>Nothing on the timeline</b>'
            'Drop a photo or a video below to start.<br>Photos can be animated with keyframes.</div>')

def transport(cur="00:04.10", total="00:21.00", playing=False):
    play = '❚❚' if playing else '▶'
    return (f'<div class="transport"><div class="tc">{cur}</div><div class="tbtn">⏮</div>'
            f'<div class="tbtn play">{play}</div><div class="tbtn">⏭</div>'
            f'<div class="tc dim">{total}</div></div>')

def slider(pct, val, label):
    return (f'<div class="row"><label>{label}</label><div class="slider"><i style="width:{pct}%"></i>'
            f'<b style="left:{pct}%"></b></div><div class="num">{val}</div></div>')

TRANSFORM_CARD = ('<div class="card"><div class="ch"><span class="dia"></span> Keyframe 2 · Transform</div><div class="cb">'
                  + slider(62,"114%","Scale") + slider(42,"−3.0","Position X") + slider(56,"+2.0","Position Y")
                  + slider(50,"0°","Rotation") + slider(100,"100%","Opacity") + '</div></div>')

def insp(*cards):
    return '<div class="insp">' + "".join(cards) + '</div>'

def insp_empty(icon, title, body):
    return (f'<div class="insp"><div class="insp-empty"><div class="ic">{icon}</div>'
            f'<b>{title}</b>{body}</div></div>')

RULER = "".join(
    f'<i style="left:{p}%"></i><span style="left:{p+0.6}%">{t}</span>'
    for p, t in [(2,"00:00"),(20,"00:03"),(38,"00:06"),(56,"00:09"),(74,"00:12"),(92,"00:15")])

def tlbar(keyframe_on=True, disabled=False, zoom="100%", zw=55, extra=""):
    d = " dis" if disabled else ""
    kf = "on" if keyframe_on and not disabled else ""
    return (f'<div class="tlbar"><div class="tool on">⌖</div><div class="tool{d}">✂</div>'
            f'<div class="tool{d}">◆</div><div class="tool{d}">🗑</div>'
            f'<div class="tool wide {kf}{d}">◆ Add keyframe</div>{extra}'
            f'<div class="zoom">ZOOM <div class="zbar"><i style="width:{zw}%"></i></div> {zoom}</div></div>')

def timeline(clips_html, bar=None, ruler=True, height=92, scrollbar=None):
    r = f'<div class="ruler">{RULER}</div>' if ruler else ""
    sb = (f'<div class="scrollbar"><i style="left:{scrollbar[0]}%;width:{scrollbar[1]}%"></i></div>'
          if scrollbar else "")
    return (f'<div class="tl">{bar if bar is not None else tlbar()}{r}'
            f'<div class="track" style="height:{height}px"><div class="clips">{clips_html}</div>{sb}</div></div>')

def photo_clip(left, width, sel=True, name="sunset.jpg", dur="6.0s", kf=None, seg=None,
               pill=None, hint=None, cluster=None, gone=False):
    cls = "clip" + (" sel" if sel else "") + (" gone" if gone else "")
    inner = ""
    if gone:
        inner = '<div class="gonetag">⚠ MEDIA OFFLINE</div>'
    else:
        inner = f'<div class="fill g1"></div>'
    inner += '<div class="grip l"><b></b></div><div class="grip r"><b></b></div>'
    inner += f'<div class="name">{html.escape(name)}</div><div class="dur">{dur}</div>'
    lane = ""
    if kf is not None or hint:
        lane_bits = []
        if seg: lane_bits.append(f'<div class="seg{" solid" if seg[2] else ""}" style="left:{seg[0]}%;right:{seg[1]}%"></div>')
        if pill: lane_bits.append(f'<div class="segpill" style="left:{pill[0]}%">{html.escape(pill[1])}</div>')
        for pos, on in (kf or []):
            lane_bits.append(f'<div class="kf{" on" if on else ""}" style="left:{pos}%"></div>')
        if cluster: lane_bits.append(f'<div class="kfcluster" style="left:{cluster[0]}%">+{cluster[1]}</div>')
        if hint: lane_bits.append(f'<div class="kfhint">{html.escape(hint)}</div>')
        lane = f'<div class="kflane">{"".join(lane_bits)}</div>'
    return f'<div class="{cls}" style="left:{left}%;width:{width}%">{inner}{lane}</div>'

def video_clip(left, width, name="surf.mp4", dur="9.0s", sel=False, ai=False, grads=("g2","g5")):
    strip = "".join(f'<div class="{grads[i%len(grads)]}"></div>' for i in range(6))
    cls = "clip" + (" sel" if sel else "") + (" ai" if ai else "")
    tag = '<div class="aitag">✦ AI</div>' if ai else ""
    return (f'<div class="{cls}" style="left:{left}%;width:{width}%"><div class="strip">{strip}</div>'
            f'<div class="grip l"><b></b></div><div class="grip r"><b></b></div>'
            f'<div class="name">{html.escape(name)}</div><div class="dur">{dur}</div>{tag}</div>')

def gen_clip(left, width, label, pct=None, sub=None, err=False):
    bits = [html.escape(label)]
    if pct is not None:
        bits.append(f'<div class="mini"><i style="width:{pct}%"></i></div>')
    if sub: bits.append(f'<div class="sub">{html.escape(sub)}</div>')
    return f'<div class="genclip{" err" if err else ""}" style="left:{left}%;width:{width}%">{"".join(bits)}</div>'

def playhead(pos): return f'<div class="playhead" style="left:{pos}%"></div>'

def shell(bin_, stage, insp_, tl, title_right=None, doc="Untitled Project — <b>beach-trip.solproj</b>",
          overlay="", body_h=378):
    tr = title_right or '<button class="btn ghost">Import</button><button class="btn primary">Export MP4</button>'
    return f"""<div class="app">
  <div class="titlebar"><div class="dots"><i></i><i></i><i></i></div>
    <div class="doc">{doc}</div><div class="tb-right">{tr}</div></div>
  <div class="body" style="height:{body_h}px">
    <div class="col"><div class="hd">Media <span class="r">{'' if bin_ is None else ''}</span></div>{bin_}</div>
    <div class="col"><div class="hd">Preview <span class="r">1920×1080 · 30 fps</span></div>{stage}{tl[1]}</div>
    <div class="col"><div class="hd">Inspector</div>{insp_}</div>
  </div>{tl[0]}{overlay}</div>"""

FRAMES = []
def frame(n, title, status, status_cls, html_body, caption):
    FRAMES.append((n, title, status, status_cls, html_body, caption))

ACTS = {}
def act(after_n, num, title):
    ACTS[after_n] = (num, title)

# ================================================================ ACT 1 — import
act(1, 1, "Getting media onto the timeline")

frame(1, "First run — empty project", "EMPTY", "",
  shell(bin_html(empty=True), stage_html(stage_empty()),
        insp_empty("◇","Nothing selected","Select a clip on the timeline to<br>edit it, or drop media to begin."),
        (timeline('<div class="dropzone"><div><b>Drop photos and videos here</b>'
                  'One timeline · they land side by side in drop order</div></div>',
                  bar=tlbar(disabled=True, keyframe_on=False)),
         transport("00:00.00","00:00.00"))),
  "<b>Trigger:</b> the app is opened with no project. Every panel states what it is waiting for instead of "
  "rendering an empty box — the timeline is one large drop target. <b>Next:</b> drag files in, or click Import.")

frame(2, "Dragging files over the window", "DRAG-OVER", "run",
  shell(bin_html(empty=True), stage_html(stage_empty()),
        insp_empty("◇","Nothing selected","Release to add 3 clips<br>to the timeline."),
        (timeline('<div class="dropzone hot"><div><b>Release to add 3 files</b>'
                  'sunset.jpg · surf.mp4 · cliff.png</div></div>'
                  '<div class="insert" style="left:4%"></div>'
                  '<div class="dragbadge">3 FILES</div>',
                  bar=tlbar(disabled=True, keyframe_on=False)),
         transport("00:00.00","00:00.00"))),
  "<b>Trigger:</b> an OS file drag enters the window. The drop zone turns accent, a vertical insertion marker shows "
  "exactly where the clips will land, and a badge counts the payload. <b>Next:</b> release to import, or drag back out to cancel.")

frame(3, "Importing — probing the files", "LOADING", "run",
  shell(bin_html(items=[("g1","▣","sunset.jpg")], skeletons=2),
        stage_html(canvas(framebox=False, hud="READING sunset.jpg")),
        insp_empty("◌","Importing 3 files","Reading dimensions and durations.<br>The editor stays usable."),
        (timeline(photo_clip(0,41,sel=False) +
                  '<div class="ghost" style="left:42%;width:40%"></div>' + playhead(0),
                  bar=tlbar(disabled=True)),
         transport("00:00.00","00:06.00"))),
  "<b>Trigger:</b> files were dropped. Each file is probed for size and duration; the bin fills with skeleton tiles and "
  "the timeline holds a dashed ghost where the pending clips will sit. <b>Next:</b> resolves to the imported state — "
  "or to a per-file error if one cannot be read.")

frame(4, "A file could not be read", "PARTIAL", "warn",
  shell(bin_html(items=[("g1","▣","sunset.jpg"),("g2","▶","surf.mp4")],
                 error="cliff.tiff — unsupported format. Supported: JPEG, PNG, WebP, MP4, MOV, WebM."),
        stage_html(canvas(framebox=False)),
        insp_empty("◇","Nothing selected","2 of 3 files imported."),
        (timeline(photo_clip(0,41,sel=False) + video_clip(42,58) + playhead(0)),
         transport("00:00.00","00:15.00"))),
  "<b>Trigger:</b> one file in the drop failed to probe. The other two still import — a partial failure never discards "
  "the whole batch — and the bin carries a named, dismissible reason. <b>Next:</b> dismiss it, or re-import a supported file.")

frame(5, "Imported — photo and video on one timeline", "SUCCESS", "ok",
  shell(bin_html(), stage_html(canvas(scale=1.0, tx="0", ty="0", framebox=False)),
        insp(('<div class="card"><div class="ch">▣ sunset.jpg · Photo</div><div class="cb">'
              '<div class="kv"><span>Duration</span><b>6.00s</b></div>'
              '<div class="kv"><span>Source</span><b>4032 × 3024</b></div>'
              '<div class="kv"><span>Keyframes</span><b>none</b></div>'
              '<div class="gen">◆ Add keyframe</div>'
              '<div class="hint">Keyframes set how the photo is framed over time. Add two and you can '
              'describe the motion between them for Higgsfield to animate.</div></div></div>')),
        (timeline(photo_clip(0,41,hint="no keyframes — click ◆ Add keyframe") +
                  video_clip(42,58) + playhead(2)),
         transport("00:00.00","00:15.00"))),
  "<b>Trigger:</b> the import finished. Both a photo and a video sit as clips on the <em>single</em> track, in drop order; "
  "the photo is selected. <b>Next:</b> add a keyframe to start animating the photo.")

# ================================================================ ACT 2 — keyframes
act(5, 2, "Keyframing the photo")

frame(6, "One keyframe — a segment needs two", "BLOCKED", "warn",
  shell(bin_html(), stage_html(canvas(scale=1.0, tx="0", ty="0", hud="KEYFRAME 1 · 00:00.00")),
        insp(TRANSFORM_CARD.replace("Keyframe 2","Keyframe 1").replace('width:62%','width:50%')
             .replace('left:62%','left:50%').replace('114%','100%'),
             ('<div class="card ai off"><div class="ch">✨ AI Segment</div><div class="cb">'
              '<div class="ta ph">Describe the motion…</div>'
              '<div class="gen dis">Generate animation</div>'
              '<div class="hint">Add a second keyframe to define a segment.</div></div></div>')),
        (timeline(photo_clip(0,41,kf=[(14,True)],hint=None) + video_clip(42,58) + playhead(2)),
         transport("00:00.00","00:15.00"))),
  "<b>Trigger:</b> the first keyframe is placed at the playhead. The transform card goes live, but the AI card is "
  "visibly disabled and says why rather than silently doing nothing. <b>Next:</b> move the playhead and add a second keyframe.")

frame(7, "Two keyframes, segment selected — ready to prompt", "READY", "ok",
  shell(bin_html(), stage_html(canvas(hud="KEYFRAME 2 · 00:04.10")),
        insp(TRANSFORM_CARD,
             ('<div class="card ai"><div class="ch">✨ AI Segment · KF1 → KF2</div><div class="cb">'
              '<div class="ta ph">Describe the motion between these two keyframes…</div>'
              '<div class="chips"><span class="chip">+ dolly in</span><span class="chip">+ parallax</span>'
              '<span class="chip">+ orbit left</span><span class="chip">+ handheld</span></div>'
              '<div class="gen dis">Generate animation · 3.2s</div>'
              '<div class="hint">Describe the motion first.</div></div></div>')),
        (timeline(photo_clip(0,41,kf=[(14,False),(54,True)],seg=(14,46,False)) +
                  video_clip(42,58) + playhead(24)),
         transport("00:04.10","00:15.00"))),
  "<b>Trigger:</b> a second keyframe exists and the dashed segment between KF1 and KF2 is selected. The prompt field "
  "unlocks and the header names the exact pair and its 3.2s length. Generate stays disabled while the prompt is empty — "
  "the reason sits under the button. <b>Next:</b> type a prompt.")

frame(8, "Prompt written", "READY", "ok",
  shell(bin_html(), stage_html(canvas(hud="KEYFRAME 2 · 00:04.10")),
        insp(TRANSFORM_CARD,
             ('<div class="card ai"><div class="ch">✨ AI Segment · KF1 → KF2</div><div class="cb">'
              '<div class="ta">slow dolly-in over the water, warm golden light, gentle waves rolling toward camera</div>'
              '<div class="chips"><span class="chip">+ dolly in</span><span class="chip">+ parallax</span>'
              '<span class="chip">+ orbit left</span><span class="chip">+ handheld</span></div>'
              '<div class="gen">Generate animation · 3.2s</div>'
              '<div class="hint">Higgsfield renders the motion between the two keyframes and drops the clip '
              'back onto this segment.</div></div></div>')),
        (timeline(photo_clip(0,41,kf=[(14,False),(54,True)],seg=(14,46,False),
                             pill=(37,"“slow dolly-in over the water…”")) +
                  video_clip(42,58) + playhead(24)),
         transport("00:04.10","00:15.00"))),
  "<b>Trigger:</b> the user describes the motion. The prompt echoes onto the timeline segment as a pill so it is readable "
  "without opening the inspector, and Generate enables. <b>Next:</b> press Generate.")

# ================================================================ ACT 3 — generation
act(8, 3, "Generating with Higgsfield")

frame(9, "No API key yet", "BLOCKED", "warn",
  shell(bin_html(), stage_html(canvas(hud="KEYFRAME 2 · 00:04.10")),
        insp(('<div class="card ai"><div class="ch">✨ AI Segment · KF1 → KF2</div><div class="cb">'
              '<div class="ta">slow dolly-in over the water, warm golden light, gentle waves rolling toward camera</div>'
              '<div class="callout" style="margin-top:10px"><b>Connect Higgsfield to generate</b>'
              'No API key is stored yet. Nothing has been sent.'
              '<span class="a">Open settings →</span></div></div></div>')),
        (timeline(photo_clip(0,41,kf=[(14,False),(54,True)],seg=(14,46,False),
                             pill=(37,"“slow dolly-in over the water…”")) +
                  video_clip(42,58) + playhead(24)),
         transport("00:04.10","00:15.00"))),
  "<b>Trigger:</b> Generate is pressed with no credentials stored. The request is never made and the prompt is preserved; "
  "the card explains rather than throwing. <b>Next:</b> open settings and paste a key.")

frame(10, "Settings — connecting Higgsfield", "DIALOG", "",
  shell(bin_html(), stage_html(canvas(hud="KEYFRAME 2 · 00:04.10")),
        insp(TRANSFORM_CARD),
        (timeline(photo_clip(0,41,kf=[(14,False),(54,True)],seg=(14,46,False)) + video_clip(42,58) + playhead(24)),
         transport("00:04.10","00:15.00")),
        overlay=('<div class="scrim"><div class="modal"><div class="mh">✦ Higgsfield connection</div>'
                 '<div class="mb">'
                 '<div class="field"><label>API key</label><div class="input">••••••••••••••••••••7fa2</div></div>'
                 '<div class="field"><label>API secret</label><div class="input">••••••••••••••••••••b41c</div></div>'
                 '<div class="field"><label>Base URL</label><div class="input">https://platform.higgsfield.ai</div></div>'
                 '<div class="field"><label>Model</label><div class="input">image2video · dop</div></div>'
                 '<div class="errbox" style="border-color:#14503c;background:#08211a;color:#a7f3d6">'
                 '<b style="color:var(--ok)">Connection OK</b>Reached the API and listed 1 model in 380 ms.</div>'
                 '</div><div class="mf"><button class="btn ghost">Cancel</button>'
                 '<button class="btn">Test connection</button><button class="btn primary">Save</button></div>'
                 '</div></div>')),
  "<b>Trigger:</b> the user opens settings. Credentials are masked, stored by the Rust backend and never handed to the "
  "webview; Test connection reports pass or fail inline before anything is spent. <b>Next:</b> save and press Generate.")

frame(11, "Queued", "QUEUED", "run",
  shell(bin_html(), stage_html(canvas(hud="KEYFRAME 2 · 00:04.10")),
        insp(('<div class="card ai"><div class="ch">✨ AI Segment · KF1 → KF2</div><div class="cb">'
              '<div class="ta" style="opacity:.65">slow dolly-in over the water, warm golden light, gentle waves…</div>'
              '<div class="kv" style="margin-top:9px"><span>Status</span><b>QUEUED</b></div>'
              '<div class="kv"><span>Job</span><b>js_9f31c…</b></div>'
              '<div class="pbar"><i style="width:4%"></i></div>'
              '<div class="btn-row"><span class="b">Cancel</span></div></div></div>')),
        (timeline(photo_clip(0,17,kf=[(34,False)],dur="1.8s") +
                  gen_clip(18,23,"Queued",pct=4,sub="js_9f31c…") +
                  video_clip(42,58) + playhead(24)),
         transport("00:04.10","00:15.00")),
        title_right='<span class="chip-run">◐ 1 rendering</span>'
                    '<button class="btn ghost">Import</button><button class="btn primary">Export MP4</button>'),
  "<b>Trigger:</b> Higgsfield accepted the job. The segment between the keyframes immediately becomes a hatched "
  "placeholder holding its place on the timeline, and a counter appears in the title bar. <b>Next:</b> it starts rendering — "
  "or you cancel and get the segment back.")

frame(12, "Rendering — the rest of the app stays usable", "RUNNING", "run",
  shell(bin_html(), stage_html(canvas(grad="g2", scale=1.0, tx="0", ty="0", framebox=False,
                                      hud="PREVIEWING surf.mp4")),
        insp(('<div class="card"><div class="ch">▶ surf.mp4 · Video</div><div class="cb">'
              '<div class="kv"><span>Duration</span><b>9.00s</b></div>'
              '<div class="kv"><span>Trim</span><b>0.00 → 9.00</b></div>'
              '<div class="hint">Videos play as-is. Keyframe animation applies to photos.</div></div></div>'),
             ('<div class="card ai"><div class="ch">✨ Rendering · KF1 → KF2</div><div class="cb">'
              '<div class="kv"><span>Progress</span><b>46%</b></div>'
              '<div class="pbar"><i style="width:46%"></i></div>'
              '<div class="btn-row"><span class="b">Cancel</span></div>'
              '<div class="hint">Runs in the background — keep editing.</div></div></div>')),
        (timeline(photo_clip(0,17,sel=False,kf=[(34,False)],dur="1.8s") +
                  gen_clip(18,23,"Rendering 46%",pct=46,sub="3.2s") +
                  video_clip(42,58,sel=True) + playhead(58)),
         transport("00:09.40","00:15.00")),
        title_right='<span class="chip-run">◐ 1 rendering</span>'
                    '<button class="btn ghost">Import</button><button class="btn primary">Export MP4</button>'),
  "<b>Trigger:</b> polling reports progress. Note the selection has moved to the video clip and its inspector works "
  "normally — generation never blocks the editor, and a second job can be started while this one runs. "
  "<b>Next:</b> it completes, or crosses the slow threshold.")

frame(13, "Taking longer than usual", "SLOW", "warn",
  shell(bin_html(), stage_html(canvas(hud="KEYFRAME 2 · 00:04.10")),
        insp(('<div class="card ai"><div class="ch">✨ Rendering · KF1 → KF2</div><div class="cb">'
              '<div class="kv"><span>Progress</span><b>62%</b></div>'
              '<div class="pbar"><i style="width:62%"></i></div>'
              '<div class="kv"><span>Elapsed</span><b>01:47</b></div>'
              '<div class="callout" style="margin-top:9px"><b>Taking longer than usual</b>'
              'Jobs normally finish in about 45–90 s. This one is still running; your edits are safe and it will '
              'land on the timeline when it is done.</div>'
              '<div class="btn-row"><span class="b">Cancel</span></div></div></div>')),
        (timeline(photo_clip(0,17,sel=False,kf=[(34,False)],dur="1.8s") +
                  gen_clip(18,23,"Rendering 62%",pct=62,sub="01:47 elapsed") +
                  video_clip(42,58) + playhead(24)),
         transport("00:04.10","00:15.00")),
        title_right='<span class="chip-run">◐ 1 rendering</span>'
                    '<button class="btn ghost">Import</button><button class="btn primary">Export MP4</button>'),
  "<b>Trigger:</b> the job passes a 90-second soft threshold. A calm advisory replaces guesswork — no modal, no spinner "
  "lock, cancel still available. <b>Next:</b> it finishes, or you cancel it.")

frame(14, "Failed — rate limited", "ERROR", "err",
  shell(bin_html(), stage_html(canvas(hud="KEYFRAME 2 · 00:04.10")),
        insp(('<div class="card err"><div class="ch">✕ Generation failed</div><div class="cb">'
              '<div class="errbox"><b>Rate limited (HTTP 429)</b>'
              'Higgsfield is throttling this key. The prompt has been kept.'
              '<code>retry-after: 30s</code></div>'
              '<div class="btn-row"><span class="b pri">Retry</span><span class="b">Dismiss</span></div>'
              '<div class="hint">Dismissing restores the plain photo segment.</div></div></div>')),
        (timeline(photo_clip(0,17,sel=False,kf=[(34,False)],dur="1.8s") +
                  gen_clip(18,23,"Failed",sub="429 rate limited",err=True) +
                  video_clip(42,58) + playhead(24)),
         transport("00:04.10","00:15.00")),
        title_right='<button class="btn ghost">Import</button><button class="btn primary">Export MP4</button>'),
  "<b>Trigger:</b> the API returned 429 (the same shape covers 401/403 auth failures and network timeouts, with the "
  "message swapped). The segment turns red in place, the prompt survives, and retry is one click. "
  "<b>Next:</b> retry, or dismiss to get the static photo segment back.")

frame(15, "Succeeded — the AI clip is on the timeline", "SUCCESS", "ok",
  shell(bin_html(), stage_html(canvas(grad="g1", scale=1.09, tx="-2%", ty="1%", framebox=False,
                                      hud="AI SEGMENT · 00:04.10", aitag=True)),
        insp(('<div class="card ai"><div class="ch">✦ AI clip · from KF1 → KF2</div><div class="cb">'
              '<div class="kv"><span>Duration</span><b>3.20s</b></div>'
              '<div class="kv"><span>Model</span><b>image2video · dop</b></div>'
              '<div class="kv"><span>Source</span><b>sunset.jpg</b></div>'
              '<div class="ta" style="margin-top:9px;opacity:.8">slow dolly-in over the water, warm golden light, '
              'gentle waves rolling toward camera</div>'
              '<div class="btn-row"><span class="b pri">Regenerate</span><span class="b">Revert to photo</span></div>'
              '</div></div>')),
        (timeline(photo_clip(0,17,sel=False,kf=[(34,False)],dur="1.8s") +
                  video_clip(18,23,name="ai-segment-01.mp4",dur="3.2s",sel=True,ai=True,grads=("g1","g4")) +
                  video_clip(42,58) + playhead(24)),
         transport("00:04.10","00:15.00")),
        title_right='<button class="btn ghost">Import</button><button class="btn primary">Export MP4</button>'),
  "<b>Trigger:</b> the job finished and the MP4 was downloaded. The generated clip has replaced the KF1→KF2 segment "
  "on the same single track, carries an <em>AI</em> badge, and plays in the preview like any other video. "
  "<b>Next:</b> play it back, regenerate with a different prompt, or revert to the static photo.")

frame(16, "Playing back", "PLAYING", "ok",
  shell(bin_html(), stage_html(canvas(grad="g1", scale=1.06, tx="-1%", ty="1%", framebox=False,
                                      hud="PLAYING · 00:02.40", aitag=False)),
        insp(TRANSFORM_CARD.replace("Keyframe 2 · Transform","Interpolated · 00:02.40")
             .replace('width:62%','width:56%').replace('left:62%','left:56%').replace('114%','107%')),
        (timeline(photo_clip(0,17,sel=False,kf=[(34,False)],dur="1.8s") +
                  video_clip(18,23,name="ai-segment-01.mp4",dur="3.2s",ai=True,grads=("g1","g4")) +
                  video_clip(42,58) + playhead(14)),
         transport("00:02.40","00:15.00",playing=True)),
        title_right='<button class="btn ghost">Import</button><button class="btn primary">Export MP4</button>'),
  "<b>Trigger:</b> space bar or the play button. The playhead sweeps the single track and the preview interpolates the "
  "photo's 2D transform between keyframes in real time, then hands off to the generated clip. <b>Next:</b> pause, or export.")

# ================================================================ ACT 4 — scale
act(16, 4, "Holding up under real projects")

frame(17, "Overflow — long timeline, long names, dense keyframes", "OVERFLOW", "warn",
  shell(bin_html(items=[("g1","▣","a-really-long-holiday-photo-name.jpeg"),("g2","▶","surf.mp4"),
                        ("g3","▣","cliff.png"),("g4","▣","market.jpg")]),
        stage_html(canvas(hud="KEYFRAME 7 · 00:11.20")),
        insp(('<div class="card ai"><div class="ch">✨ AI Segment · KF6 → KF7</div><div class="cb">'
              '<div class="ta scroll">a slow cinematic dolly-in over the water with warm golden hour light, gentle '
              'waves rolling toward the camera, subtle parallax on the cliffs in the background, a few gulls drifting '
              'across the upper third, film grain and a soft anamorphic flare as the sun clips the horizon…</div>'
              '<div class="gen">Generate animation · 2.4s</div>'
              '<div class="hint">The field scrolls at a fixed height — Generate never leaves the panel.</div>'
              '</div></div>')),
        (timeline(photo_clip(0,26,name="a-really-long-holiday-photo-name.jpeg",dur="6.0s",
                             kf=[(8,False),(16,False),(24,False),(38,True),(46,False)],
                             seg=(24,54,False), pill=(31,"“a slow cinematic dolly-in over the wa…”"),
                             cluster=(66,4)) +
                  video_clip(27,9,name="surf.mp4",dur="1.1s") +
                  video_clip(36.5,14,name="ai-segment-01.mp4",dur="3.2s",ai=True,grads=("g1","g4")) +
                  photo_clip(51,4,sel=False,name="",dur="",kf=None) +
                  video_clip(55.5,20,name="drive.mov",dur="4.6s",grads=("g5","g3")) +
                  video_clip(76,24,name="market-timelapse-final-v3.mp4",dur="5.5s",grads=("g4","g6")) +
                  playhead(44), scrollbar=(6,58)),
         transport("00:11.20","01:12.00")),
        title_right='<button class="btn ghost">Import</button><button class="btn primary">Export MP4</button>'),
  "<b>Trigger:</b> a project big enough to overflow. The track scrolls horizontally with the ruler in sync; long file names "
  "truncate with an ellipsis; a clip too narrow for a label keeps only its thumbnail; keyframes closer than the minimum "
  "spacing collapse into a <em>+4</em> cluster that expands on zoom; and a very long prompt scrolls inside a fixed-height "
  "field. <b>Next:</b> zoom in to work on a dense region.")

frame(18, "Source file went missing", "ERROR", "err",
  shell(bin_html(items=[("g2","▶","surf.mp4"),("g3","▣","cliff.png")],
                 error="sunset.jpg — file no longer exists at /home/…/Pictures/sunset.jpg"),
        stage_html(canvas(offline=True)),
        insp(('<div class="card err"><div class="ch">⚠ Media offline</div><div class="cb">'
              '<div class="errbox"><b>sunset.jpg is missing</b>'
              'The source file was moved or deleted after import. Export is blocked until this is resolved.'
              '<code>/home/…/Pictures/sunset.jpg</code></div>'
              '<div class="btn-row"><span class="b pri">Relink…</span><span class="b">Remove clip</span></div>'
              '</div></div>')),
        (timeline(photo_clip(0,41,gone=True,name="sunset.jpg",dur="6.0s") +
                  video_clip(42,58) + playhead(2)),
         transport("00:00.00","00:15.00")),
        title_right='<button class="btn ghost">Import</button><button class="btn primary dis">Export MP4</button>'),
  "<b>Trigger:</b> a source file was moved or deleted after import. The clip stays on the timeline as a hatched "
  "placeholder rather than vanishing, Export is disabled with the reason, and the exact path is shown. "
  "<b>Next:</b> relink the file, or remove the clip.")

# ================================================================ ACT 5 — export
act(18, 5, "Exporting")

frame(19, "Exporting to MP4", "RUNNING", "run",
  shell(bin_html(), stage_html(canvas(grad="g1", scale=1.06, framebox=False)),
        insp(TRANSFORM_CARD),
        (timeline(photo_clip(0,17,sel=False,kf=[(34,False)],dur="1.8s") +
                  video_clip(18,23,name="ai-segment-01.mp4",dur="3.2s",ai=True,grads=("g1","g4")) +
                  video_clip(42,58) + playhead(24)),
         transport("00:04.10","00:15.00")),
        overlay=('<div class="scrim"><div class="modal"><div class="mh">Exporting beach-trip.mp4</div>'
                 '<div class="mb"><div class="stagelist">'
                 '<div class="stagerow done"><span class="d">✓</span>Normalising 3 clips to 1920×1080 · 30 fps</div>'
                 '<div class="stagerow now"><span class="d">◐</span>Rendering keyframe motion — clip 2 of 3</div>'
                 '<div class="stagerow"><span class="d"></span>Concatenating</div>'
                 '<div class="stagerow"><span class="d"></span>Finalising (faststart)</div>'
                 '</div><div class="pbar"><i style="width:52%"></i></div>'
                 '<div class="kv"><span>Elapsed 00:24</span><b>52%</b></div></div>'
                 '<div class="mf"><button class="btn ghost">Cancel</button></div></div></div>')),
  "<b>Trigger:</b> Export MP4 is pressed. ffmpeg runs the clips through per-stage progress rather than one opaque bar, "
  "so a long export is legible. <b>Next:</b> it finishes and a toast points at the file — or it fails with a real reason.")

frame(20, "Exported", "SUCCESS", "ok",
  shell(bin_html(), stage_html(canvas(grad="g1", scale=1.06, framebox=False)),
        insp(TRANSFORM_CARD),
        (timeline(photo_clip(0,17,sel=False,kf=[(34,False)],dur="1.8s") +
                  video_clip(18,23,name="ai-segment-01.mp4",dur="3.2s",ai=True,grads=("g1","g4")) +
                  video_clip(42,58) + playhead(24)),
         transport("00:04.10","00:15.00")),
        overlay=('<div class="toast ok"><div class="ic">✓</div><div class="tx"><b>Export complete</b>'
                 '<span>~/Videos/beach-trip.mp4 · 14.8 MB · 00:15.00</span></div>'
                 '<div class="a">Reveal</div></div>')),
  "<b>Trigger:</b> ffmpeg exited 0. A toast names the output, its size and duration, and offers to reveal it in the file "
  "manager — no modal to dismiss. <b>Next:</b> keep editing; the toast auto-dismisses.")

frame(21, "Export failed — ffmpeg missing", "ERROR", "err",
  shell(bin_html(), stage_html(canvas(grad="g1", scale=1.06, framebox=False)),
        insp(TRANSFORM_CARD),
        (timeline(photo_clip(0,17,sel=False,kf=[(34,False)],dur="1.8s") +
                  video_clip(18,23,name="ai-segment-01.mp4",dur="3.2s",ai=True,grads=("g1","g4")) +
                  video_clip(42,58) + playhead(24)),
         transport("00:04.10","00:15.00")),
        overlay=('<div class="scrim"><div class="modal"><div class="mh">✕ Export failed</div>'
                 '<div class="mb"><div class="errbox"><b>ffmpeg was not found</b>'
                 'SolCut renders the timeline with ffmpeg. Install it and make sure it is on your PATH, then try again. '
                 'Nothing was written to disk.'
                 '<code>macOS   brew install ffmpeg\nUbuntu  sudo apt install ffmpeg\nWindows winget install ffmpeg</code>'
                 '</div></div>'
                 '<div class="mf"><button class="btn ghost">Close</button>'
                 '<button class="btn primary">Try again</button></div></div></div>')),
  "<b>Trigger:</b> export was requested but the encoder is unavailable (the same dialog carries ffmpeg's stderr tail when "
  "an encode fails instead). The export is refused up front rather than leaving a half-written file. "
  "<b>Next:</b> install ffmpeg and retry.")

# ================================================================ render
out = io.StringIO()
out.write('<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8" />\n'
          '<meta name="viewport" content="width=device-width, initial-scale=1" />\n'
          '<title>SolCut — UX walkthrough</title>\n<style>\n' + CSS + '\n</style>\n</head>\n<body>\n<div class="page">\n')
out.write('<div class="kicker">SOL-8EO6UT · hi-fi walkthrough · concept 1 “Midnight Studio”</div>\n')
out.write('<h1>SolCut — the complete flow, screen by screen</h1>\n')
out.write('<p class="lede">Every screen and state a user meets, in the order they meet it, drawn with the approved '
          'Midnight Studio design system — the same tokens (<code style="font-family:var(--mono);font-size:11px;'
          'color:var(--accent-2)">src/styles/tokens.css</code>) the app is built from. Each frame says what triggers it '
          'and what the user can do next, so the sequence reads start to finish without gaps.</p>\n')
out.write('<div class="toc">' + "".join(
    f'<a href="#f{n}">{n}. {html.escape(t)}</a>' for n,t,_,_,_,_ in FRAMES) + '</div>\n')

# an act header is emitted immediately before the frame that opens it
OPENERS = {1: ACTS[1]}
for after_n, spec in ACTS.items():
    if after_n != 1:
        OPENERS[after_n + 1] = spec

for n, title, status, scls, body, caption in FRAMES:
    if n in OPENERS:
        num, at = OPENERS[n]
        out.write(f'<div class="act"><span>Act {num}</span><h2>{html.escape(at)}</h2></div>\n')
    out.write(f'<figure id="f{n}"><div class="stepno"><b>{n}</b><span class="t">{html.escape(title)}</span>'
              f'<span class="s {scls}">{status}</span></div>\n{body}\n'
              f'<figcaption>{caption}</figcaption></figure>\n')

out.write('</div>\n</body>\n</html>\n')
pathlib.Path("design/walkthrough.html").write_text(out.getvalue())
print("frames:", len(FRAMES), "bytes:", len(out.getvalue()))
