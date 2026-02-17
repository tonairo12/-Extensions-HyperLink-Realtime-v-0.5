(function (Scratch) {
  'use strict';

  if (!Scratch.extensions.unsandboxed) {
    throw new Error('HyperLink v1 requires unsandboxed mode');
  }

  const runtime = Scratch.vm.runtime;

  class HyperLinkV1 {
    constructor() {
      this.apiRegistry = {};   
      this.dataStorage = {};   
      this.sockets = {};       
      this.isLooping = {};     
      this.lastData = {};      
      this.connectedState = {}; 
      this.manualDisconnect = {}; 
      this.sendQueues = {};
      this.errorModes = {}; 
      this.eventQueues = { onConnected: new Set(), onMessageReceived: new Set(), onDisconnected: new Set(), onError: new Set() };
    }

    getInfo() {
      return {
        id: 'hyperlinkV1',
        name: 'HyperLink v1',
        color1: '#0080ff',
        blocks: [
          { opcode: 'onConnected', blockType: Scratch.BlockType.HAT, text: 'ラベル [LABEL] が新規接続されたとき', arguments: { LABEL: { type: Scratch.ArgumentType.STRING, defaultValue: 'API_1' } } },
          { opcode: 'onMessageReceived', blockType: Scratch.BlockType.HAT, text: 'ラベル [LABEL] で情報/応答が届いたとき', arguments: { LABEL: { type: Scratch.ArgumentType.STRING, defaultValue: 'API_1' } } },
          { opcode: 'onError', blockType: Scratch.BlockType.HAT, text: 'ラベル [LABEL] で接続Errorが起きたとき', arguments: { LABEL: { type: Scratch.ArgumentType.STRING, defaultValue: 'API_1' } } },
          { opcode: 'onDisconnected', blockType: Scratch.BlockType.HAT, text: 'ラベル [LABEL] の接続が解除されたとき', arguments: { LABEL: { type: Scratch.ArgumentType.STRING, defaultValue: 'API_1' } } },
          "---",
          { opcode: 'connectAndRegister', blockType: Scratch.BlockType.COMMAND, text: 'ラベル [LABEL] で URL [URL] を登録', arguments: { LABEL: { type: Scratch.ArgumentType.STRING, defaultValue: 'API_1' }, URL: { type: Scratch.ArgumentType.STRING, defaultValue: 'https://api.example.com' } } },
          { opcode: 'setModeAndRun', blockType: Scratch.BlockType.COMMAND, text: 'ラベル [LABEL] を [MODE] モードで開始', arguments: { LABEL: { type: Scratch.ArgumentType.STRING, defaultValue: 'API_1' }, MODE: { type: Scratch.ArgumentType.STRING, menu: 'modeMenu', defaultValue: '常時接続' } } },
          { opcode: 'setErrorMode', blockType: Scratch.BlockType.COMMAND, text: 'ラベル [LABEL] のError処理を [ERROR_MODE] にする', arguments: { LABEL: { type: Scratch.ArgumentType.STRING, defaultValue: 'API_1' }, ERROR_MODE: { type: Scratch.ArgumentType.STRING, menu: 'errorModeMenu', defaultValue: '1. 自動再接続' } } },
          { opcode: 'sendToLabel', blockType: Scratch.BlockType.COMMAND, text: 'ラベル [LABEL] にメッセージ [MSG] を送信', arguments: { LABEL: { type: Scratch.ArgumentType.STRING, defaultValue: 'API_1' }, MSG: { type: Scratch.ArgumentType.STRING, defaultValue: '' } } },
          { opcode: 'getLatest', blockType: Scratch.BlockType.REPORTER, text: 'ラベル [LABEL] の最新データ', arguments: { LABEL: { type: Scratch.ArgumentType.STRING, defaultValue: 'API_1' } } },
          { opcode: 'disconnectLabel', blockType: Scratch.BlockType.COMMAND, text: 'ラベル [LABEL] の接続を解除', arguments: { LABEL: { type: Scratch.ArgumentType.STRING, defaultValue: 'API_1' } } }
        ],
        menus: {
          modeMenu: { acceptReporters: true, items: ['常時接続', '直出力'] },
          errorModeMenu: { items: ['1. 自動再接続', '2. ハットでの対応'] }
        }
      };
    }

    _checkEvent(opcode, label) { if (this.eventQueues[opcode].has(label)) { this.eventQueues[opcode].delete(label); return true; } return false; }
    onConnected(args) { return this._checkEvent('onConnected', args.LABEL); }
    onMessageReceived(args) { return this._checkEvent('onMessageReceived', args.LABEL); }
    onError(args) { return this._checkEvent('onError', args.LABEL); }
    onDisconnected(args) { return this._checkEvent('onDisconnected', args.LABEL); }
    _emit(opcode, label) { this.eventQueues[opcode].add(label); runtime.requestRedraw(); }

    connectAndRegister(args) { this.apiRegistry[args.LABEL] = args.URL; this.manualDisconnect[args.LABEL] = false; }
    setModeAndRun(args) { if (this.apiRegistry[args.LABEL]) { this.manualDisconnect[args.LABEL] = false; this._startConnection(args.LABEL, this.apiRegistry[args.LABEL], args.MODE); } }
    setErrorMode(args) { this.errorModes[args.LABEL] = args.ERROR_MODE; }

    _startConnection(label, url, mode) {
      this.isLooping[label] = false;
      if (this.sockets[label]) { this.sockets[label].onclose = null; this.sockets[label].close(); delete this.sockets[label]; }
      this.connectedState[label] = false;
      if (url.startsWith('ws')) { this._setupWS(label, url, mode === '直出力'); } 
      else { this.isLooping[label] = true; this._httpLoop(label, url, mode === '直出力'); }
    }

    async _httpLoop(label, url, once) {
      while (this.isLooping[label]) {
        try {
          const res = await fetch(`${url}${url.includes('?') ? '&' : '?'}_t=${Date.now()}`, { cache: 'no-store' });
          const text = await res.text();
          if (!this.connectedState[label]) { this.connectedState[label] = true; this._emit('onConnected', label); }
          // 白紙データ（空文字）でなければ保存してイベント発火
          if (text.trim() !== "" && this.lastData[label] !== text) {
            this.dataStorage[label] = text; this.lastData[label] = text; this._emit('onMessageReceived', label);
            if (once) { this.isLooping[label] = false; break; }
          }
        } catch (e) {
          this._emit('onError', label);
          if (once || this.errorModes[label] === '2. ハットでの対応') { this.isLooping[label] = false; break; }
          await new Promise(r => setTimeout(r, 3000));
        }
        if (!this.isLooping[label]) break;
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    _setupWS(label, url, once) {
      const ws = new WebSocket(url);
      this.sockets[label] = ws;
      const keepAlive = setInterval(() => { if (ws.readyState > 1) clearInterval(keepAlive); }, 500);

      ws.onopen = () => {
        this.connectedState[label] = true; this._emit('onConnected', label);
        if (this.sendQueues[label]) { this.sendQueues[label].forEach(m => ws.send(m)); this.sendQueues[label] = []; }
      };

      ws.onmessage = (e) => {
        // 白紙ガード：中身がある場合のみ更新
        if (e.data.trim() !== "") {
          this.dataStorage[label] = e.data; this.lastData[label] = e.data;
          this._emit('onMessageReceived', label);
          // 直出力モードの場合、有効なデータを受け取って初めて切断する
          if (once) { this.disconnectLabel({LABEL: label}); }
        }
      };

      ws.onclose = () => {
        clearInterval(keepAlive);
        if (this.connectedState[label]) { this.connectedState[label] = false; this._emit('onDisconnected', label); }
        if (!this.manualDisconnect[label] && !once && this.errorModes[label] !== '2. ハットでの対応') {
          setTimeout(() => { if (this.apiRegistry[label]) this._setupWS(label, url, false); }, 3000);
        }
      };
      ws.onerror = () => { this._emit('onError', label); ws.close(); };
    }

    sendToLabel(args) {
      const ws = this.sockets[args.LABEL];
      if (ws && ws.readyState === 1) ws.send(args.MSG || "");
      else { if (!this.sendQueues[args.LABEL]) this.sendQueues[args.LABEL] = []; this.sendQueues[args.LABEL].push(args.MSG || ""); }
    }

    getLatest(args) { return this.dataStorage[args.LABEL] || ""; }

    disconnectLabel(args) {
      const label = args.LABEL; this.manualDisconnect[label] = true; this.isLooping[label] = false;
      if (this.sockets[label]) { this.sockets[label].onclose = null; this.sockets[label].close(); delete this.sockets[label]; }
      this.connectedState[label] = false; this._emit('onDisconnected', label);
    }
  }

  Scratch.extensions.register(new HyperLinkV1());
})(Scratch);
