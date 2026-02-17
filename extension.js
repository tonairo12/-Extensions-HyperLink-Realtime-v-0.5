(function (Scratch) {
  'use strict';

  if (!Scratch.extensions.unsandboxed) {
    throw new Error('HyperLink Realtime requires unsandboxed mode');
  }

  const runtime = Scratch.vm.runtime;

  class HyperLinkV39 {
    constructor() {
      this.apiRegistry = {};   
      this.dataStorage = {};   
      this.sockets = {};       
      this.isLooping = {};     
      this.lastData = {};      
      this.connectedState = {}; 
      this.manualDisconnect = {}; 
      this.sendQueues = {};
      this.errorModes = {}; // 1: 自動再接続, 2: ハット対応

      // 物理的重複発火を阻止するイベントキュー
      this.eventQueues = {
        onConnected: new Set(),
        onMessageReceived: new Set(),
        onDisconnected: new Set(),
        onError: new Set()
      };
    }

    getInfo() {
      return {
        id: 'hyperLinkV39',
        name: 'HyperLink Realtime: 究極V39',
        color1: '#0080ff',
        blocks: [
          {
            opcode: 'onConnected',
            blockType: Scratch.BlockType.HAT,
            text: 'ラベル [LABEL] が新規接続されたとき',
            arguments: { LABEL: { type: Scratch.ArgumentType.STRING, defaultValue: 'API_1' } }
          },
          {
            opcode: 'onMessageReceived',
            blockType: Scratch.BlockType.HAT,
            text: 'ラベル [LABEL] で情報/応答が届いたとき',
            arguments: { LABEL: { type: Scratch.ArgumentType.STRING, defaultValue: 'API_1' } }
          },
          {
            opcode: 'onError',
            blockType: Scratch.BlockType.HAT,
            text: 'ラベル [LABEL] で接続Errorが起きたとき',
            arguments: { LABEL: { type: Scratch.ArgumentType.STRING, defaultValue: 'API_1' } }
          },
          {
            opcode: 'onDisconnected',
            blockType: Scratch.BlockType.HAT,
            text: 'ラベル [LABEL] の接続が解除されたとき',
            arguments: { LABEL: { type: Scratch.ArgumentType.STRING, defaultValue: 'API_1' } }
          },
          "---",
          {
            opcode: 'connectAndRegister',
            blockType: Scratch.BlockType.COMMAND,
            text: 'ラベル [LABEL] で URL [URL] を登録して接続',
            arguments: {
              LABEL: { type: Scratch.ArgumentType.STRING, defaultValue: 'API_1' },
              URL: { type: Scratch.ArgumentType.STRING, defaultValue: 'https://api.example.com' }
            }
          },
          {
            opcode: 'setModeAndRun',
            blockType: Scratch.BlockType.COMMAND,
            text: 'ラベル [LABEL] を [MODE] モードへ変換',
            arguments: {
              LABEL: { type: Scratch.ArgumentType.STRING, defaultValue: 'API_1' },
              MODE: { type: Scratch.ArgumentType.STRING, menu: 'modeMenu', defaultValue: '自動変換' }
            }
          },
          {
            opcode: 'setErrorMode',
            blockType: Scratch.BlockType.COMMAND,
            text: 'ラベル [LABEL] のError処理を [ERROR_MODE] にする',
            arguments: {
              LABEL: { type: Scratch.ArgumentType.STRING, defaultValue: 'API_1' },
              ERROR_MODE: { type: Scratch.ArgumentType.STRING, menu: 'errorModeMenu', defaultValue: '1. 自動再接続' }
            }
          },
          {
            opcode: 'sendToLabel',
            blockType: Scratch.BlockType.COMMAND,
            text: 'ラベル [LABEL] にメッセージ [MSG] を送信',
            arguments: {
              LABEL: { type: Scratch.ArgumentType.STRING, defaultValue: 'API_1' },
              MSG: { type: Scratch.ArgumentType.STRING, defaultValue: '' }
            }
          },
          {
            opcode: 'getLatest',
            blockType: Scratch.BlockType.REPORTER,
            text: 'ラベル [LABEL] の最新データ',
            arguments: { LABEL: { type: Scratch.ArgumentType.STRING, defaultValue: 'API_1' } }
          },
          {
            opcode: 'disconnectLabel',
            blockType: Scratch.BlockType.COMMAND,
            text: 'ラベル [LABEL] の接続を解除',
            arguments: { LABEL: { type: Scratch.ArgumentType.STRING, defaultValue: 'API_1' } }
          }
        ],
        menus: {
          modeMenu: { acceptReporters: true, items: ['自動変換', '常時接続', '直出力'] },
          errorModeMenu: { items: ['1. 自動再接続', '2. ハットでの対応'] }
        }
      };
    }

    // --- ハットブロック：エッジトリガー判定 ---
    _checkEvent(opcode, label) {
      if (this.eventQueues[opcode].has(label)) {
        this.eventQueues[opcode].delete(label);
        return true;
      }
      return false;
    }
    onConnected(args) { return this._checkEvent('onConnected', args.LABEL); }
    onMessageReceived(args) { return this._checkEvent('onMessageReceived', args.LABEL); }
    onError(args) { return this._checkEvent('onError', args.LABEL); }
    onDisconnected(args) { return this._checkEvent('onDisconnected', args.LABEL); }

    _emit(opcode, label) {
      this.eventQueues[opcode].add(label);
      runtime.requestRedraw();
    }

    // --- 通信コアロジック ---
    connectAndRegister(args) {
      this.apiRegistry[args.LABEL] = args.URL;
      this.manualDisconnect[args.LABEL] = false;
      if (!this.errorModes[args.LABEL]) this.errorModes[args.LABEL] = '1. 自動再接続';
      this._startConnection(args.LABEL, args.URL, '自動変換');
    }

    setModeAndRun(args) {
      const url = this.apiRegistry[args.LABEL];
      if (url) this._startConnection(args.LABEL, url, args.MODE);
    }

    setErrorMode(args) {
      this.errorModes[args.LABEL] = args.ERROR_MODE;
    }

    _startConnection(label, url, mode) {
      this.isLooping[label] = false;
      if (this.sockets[label]) {
        this.sockets[label].onclose = null;
        this.sockets[label].close();
        delete this.sockets[label];
      }
      this.connectedState[label] = false;

      const isWs = (mode === '自動変換') ? url.startsWith('ws') : (mode === '常時接続');

      if (isWs) {
        this._setupWS(label, url);
      } else {
        this.isLooping[label] = true;
        this._httpLoop(label, url, mode === '直出力');
      }
    }

    async _httpLoop(label, url, once) {
      do {
        try {
          const sep = url.includes('?') ? '&' : '?';
          const fastUrl = `${url}${sep}_t=${Date.now()}`;
          const res = await fetch(fastUrl, { cache: 'no-store' });
          if (!res.ok) throw new Error();
          const text = await res.text();

          if (!this.connectedState[label]) {
            this.connectedState[label] = true;
            this._emit('onConnected', label);
          }
          if (this.lastData[label] !== text) {
            this.dataStorage[label] = text;
            this.lastData[label] = text;
            this._emit('onMessageReceived', label);
          }
        } catch (e) {
          this._emit('onError', label);
          if (this.connectedState[label]) {
            this.connectedState[label] = false;
            this._emit('onDisconnected', label);
          }
          if (this.errorModes[label] === '2. ハットでの対応') {
            this.isLooping[label] = false;
            break;
          }
          if (!once) await new Promise(r => setTimeout(r, 3000));
        }
        if (once) break;
        await new Promise(r => setTimeout(r, 2000));
      } while (this.isLooping[label]);
    }

    _setupWS(label, url) {
      if (!url.startsWith('ws')) url = 'wss://' + url;
      const ws = new WebSocket(url);
      this.sockets[label] = ws;

      ws.onopen = () => {
        this.connectedState[label] = true;
        this._emit('onConnected', label);
        if (this.sendQueues[label]) {
          this.sendQueues[label].forEach(m => ws.send(m));
          this.sendQueues[label] = [];
        }
      };
      ws.onmessage = (e) => {
        this.dataStorage[label] = e.data;
        this.lastData[label] = e.data;
        this._emit('onMessageReceived', label);
      };
      ws.onerror = () => {
        this._emit('onError', label);
      };
      ws.onclose = () => {
        if (this.connectedState[label]) {
          this.connectedState[label] = false;
          this._emit('onDisconnected', label);
        }
        if (!this.manualDisconnect[label] && this.errorModes[label] === '1. 自動再接続') {
          setTimeout(() => { if (this.apiRegistry[label]) this._setupWS(label, url); }, 3000);
        }
      };
    }

    sendToLabel(args) {
      const ws = this.sockets[args.LABEL];
      if (ws && ws.readyState === 1) ws.send(args.MSG || "");
      else {
        if (!this.sendQueues[args.LABEL]) this.sendQueues[args.LABEL] = [];
        this.sendQueues[args.LABEL].push(args.MSG || "");
      }
    }

    getLatest(args) { return this.dataStorage[args.LABEL] || ""; }

    disconnectLabel(args) {
      const label = args.LABEL;
      this.manualDisconnect[label] = true;
      this.isLooping[label] = false;
      if (this.sockets[label]) {
        this.sockets[label].onclose = null;
        this.sockets[label].close();
        delete this.sockets[label];
      }
      this.connectedState[label] = false;
      this._emit('onDisconnected', label);
      this.dataStorage[label] = ""; 
    }
  }

  Scratch.extensions.register(new HyperLinkV39());
})(Scratch);
