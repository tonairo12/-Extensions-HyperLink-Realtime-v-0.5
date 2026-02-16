(function (Scratch) {
  'use strict';

  if (!Scratch.extensions.unsandboxed) {
    throw new Error('HyperLink Realtime vβ0.5 must run unsandboxed');
  }

  const runtime = Scratch.vm.runtime;

  class HyperLinkRealtime {
    constructor() {
      this.apiRegistry = {};   
      this.dataStorage = {};   
      this.sockets = {};       
      this.isLooping = {};     
      this.lastData = {};      
      this.connectedState = {}; 
      this.manualDisconnect = {}; 
      this.sendQueues = {}; 

      // 物理的重複発火を阻止するエッジトリガーキュー
      this.eventQueues = {
        onConnected: new Set(),
        onMessageReceived: new Set(),
        onDisconnected: new Set()
      };
    }

    getInfo() {
      return {
        id: 'hyperLinkRealtimeV05',
        name: 'HyperLink Realtime vβ0.5',
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
            text: 'ラベル [LABEL] を [MODE] モードへ強制変換',
            arguments: {
              LABEL: { type: Scratch.ArgumentType.STRING, defaultValue: 'API_1' },
              MODE: { type: Scratch.ArgumentType.STRING, menu: 'modeMenu', defaultValue: '自動変換' }
            }
          },
          {
            opcode: 'sendToLabel',
            blockType: Scratch.BlockType.COMMAND,
            text: 'ラベル [LABEL] にメッセージ [MSG] を送信 (接続待ち対応)',
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
          modeMenu: { acceptReporters: true, items: ['自動変換', '常時接続', '直出力'] }
        }
      };
    }

    _checkEvent(opcode, label) {
      if (this.eventQueues[opcode].has(label)) {
        this.eventQueues[opcode].delete(label);
        return true;
      }
      return false;
    }
    onConnected(args) { return this._checkEvent('onConnected', args.LABEL); }
    onMessageReceived(args) { return this._checkEvent('onMessageReceived', args.LABEL); }
    onDisconnected(args) { return this._checkEvent('onDisconnected', args.LABEL); }

    _emit(opcode, label) {
      this.eventQueues[opcode].add(label);
      runtime.requestRedraw();
    }

    connectAndRegister(args) {
      this.apiRegistry[args.LABEL] = args.URL;
      this.setModeAndRun({ LABEL: args.LABEL, MODE: '自動変換' });
    }

    setModeAndRun(args) {
      const url = this.apiRegistry[args.LABEL];
      if (!url) return;
      this.manualDisconnect[args.LABEL] = false;
      
      this.isLooping[args.LABEL] = false;
      if (this.sockets[args.LABEL]) {
        this.sockets[args.LABEL].onclose = null;
        this.sockets[args.LABEL].close();
        delete this.sockets[args.LABEL];
      }
      this.connectedState[args.LABEL] = false;

      const isWs = (args.MODE === '自動変換') ? url.startsWith('ws') : (args.MODE === '常時接続');
      if (isWs) this._setupWS(args.LABEL, url); else { this.isLooping[args.LABEL] = true; this._httpLoop(args.LABEL, url, args.MODE === '直出力'); }
    }

    async _httpLoop(label, url, once) {
      do {
        try {
          const sep = url.includes('?') ? '&' : '?';
          const res = await fetch(`${url}${sep}_t=${Date.now()}`, { cache: 'no-store' });
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
          if (this.connectedState[label]) {
            this.connectedState[label] = false;
            this._emit('onDisconnected', label);
          }
          if (!this.manualDisconnect[label] && !once) {
            await new Promise(r => setTimeout(r, 3000));
            continue;
          }
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
          this.sendQueues[label].forEach(msg => ws.send(msg));
          this.sendQueues[label] = [];
        }
      };
      ws.onmessage = (e) => {
        this.dataStorage[label] = e.data;
        this.lastData[label] = e.data;
        this._emit('onMessageReceived', label);
      };
      ws.onclose = () => {
        if (this.connectedState[label]) {
          this.connectedState[label] = false;
          this._emit('onDisconnected', label);
        }
        if (!this.manualDisconnect[label]) setTimeout(() => this._setupWS(label, url), 3000);
      };
      ws.onerror = () => ws.close();
    }

    sendToLabel(args) {
      const label = args.LABEL;
      const msg = args.MSG || "";
      const ws = this.sockets[label];

      if (ws && ws.readyState === 1) {
        ws.send(msg);
      } else {
        if (!this.sendQueues[label]) this.sendQueues[label] = [];
        this.sendQueues[label].push(msg);
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

  Scratch.extensions.register(new HyperLinkRealtime());
})(Scratch);
