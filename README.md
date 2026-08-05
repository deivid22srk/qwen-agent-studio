# Qwen Agent Studio

> Extensão Chrome (Manifest V3) que transforma a interface do [Qwen AI](https://chat.qwen.ai) em um verdadeiro **agente com suporte a Tool Calls**, com acesso a uma **pasta de projetos local** — estilo **OpenCode** / **Claude Code**.

## ✨ O que ela faz

- **Injeta** elementos discretos na própria UI do Qwen (botão flutuante + painel lateral). **Nenhuma interface paralela** é criada.
- **Tool calls reais**: ler, escrever, editar, listar e buscar arquivos dentro da pasta selecionada.
- **File System Access API**: o usuário escolhe uma pasta do computador; o agente opera sobre ela.
- **Detecção automática**: as respostas do modelo são parseadas em busca de `<tool_call>...</tool_call>`; a ferramenta é executada e o resultado é reinjetado como nova mensagem.
- **100% local**: nenhum dado sai do navegador. Os handles de arquivo ficam no IndexedDB.

## 🛠️ Ferramentas disponíveis

| Nome               | Descrição                                     |
|--------------------|-----------------------------------------------|
| `list_files`       | Lista o conteúdo de um diretório              |
| `tree`             | Mostra a árvore de diretórios                 |
| `read_file`        | Lê o conteúdo de um arquivo                   |
| `write_file`       | Cria ou sobrescreve um arquivo                |
| `edit_file`        | Substitui trecho exato de um arquivo          |
| `append_file`      | Anexa conteúdo ao final                       |
| `delete_file`      | Apaga um arquivo                              |
| `create_directory` | Cria diretório (recursivo)                    |
| `search_files`     | Busca por nome (glob `*` e `?`)               |
| `grep`             | Busca conteúdo em arquivos                    |
| `run_command`      | Executa shell (requer helper opcional)        |
| `finish`           | Sinaliza fim da tarefa                        |

## 🚀 Instalação

### Opção A — Baixar .zip (recomendado para usuários)

1. Acesse a [GitHub Pages](https://deivid22srk.github.io/qwen-agent-studio/) e clique em **Baixar extensão (.zip)**.
2. Extraia o `.zip`.
3. Abra `chrome://extensions` no Chrome (ou equivalente em Edge, Brave, Opera).
4. Ative o **Modo desenvolvedor** no canto superior direito.
5. Clique em **Carregar sem compactação** e selecione a pasta `qwen-agent-extension`.

### Opção B — Clonar o repositório

```bash
git clone https://github.com/deivid22srk/qwen-agent-studio.git
```

Depois siga os passos 3–5 acima apontando para a pasta `qwen-agent-extension/`.

## 📖 Como usar

1. Abra [chat.qwen.ai](https://chat.qwen.ai).
2. Clique no botão flutuante 🤖 no canto inferior direito.
3. Clique em **📁 Selecionar pasta** e escolha a pasta do seu projeto.
4. Ligue o **Modo Agente** no painel.
5. Converse normalmente com o Qwen — agora ele pode executar tarefas no seu projeto.

### Exemplos de prompts

- "liste os arquivos do projeto"
- "leia o `src/index.js` e explique o que faz"
- "crie um arquivo `test.py` que imprime Olá Mundo"
- "encontre onde fica a função `main`"
- "renomeie todas as ocorrências de `foo` para `bar` em `src/`"

## 🏗️ Arquitetura

```
qwen-agent-extension/
├── manifest.json              # Manifest V3
├── background.js              # Service worker
├── content.js                 # Injetado no chat.qwen.ai — orquestra tudo
├── content.css                # Estilos mínimos
├── popup.html / .js / .css    # UI do popup da extensão
├── lib/
│   ├── store.js               # IndexedDB + chrome.storage
│   ├── fs.js                  # Wrapper da File System Access API
│   ├── tools.js               # Catálogo de ferramentas
│   ├── parser.js              # Detecta <tool_call> e monta system prompt
│   └── injector.js            # Injeta UI flutuante no Qwen
├── icons/                     # 16/48/128px + SVG
└── docs/                      # GitHub Pages (landing page)
```

## 🔒 Segurança

- O agente só pode operar dentro da pasta que você selecionar.
- Permissões de leitura/escrita são pedidas explicitamente via File System Access API.
- `run_command` requer um **helper opcional** (companion app Node.js, ainda não incluso nesta release) — sem ele, a extensão é puramente de arquivos.

## 🤝 Compatibilidade

Qualquer navegador baseado em Chromium:
- Google Chrome 102+
- Microsoft Edge 102+
- Brave
- Opera
- Arc

## 📝 Licença

MIT

## 👤 Autor

[@deivid22srk](https://github.com/deivid22srk)

---

**Disclaimer**: Este projeto não é afiliado, endossado ou mantido pela Alibaba ou pela equipe Qwen. É uma ferramenta independente que injeta funcionalidades extra na interface web do Qwen AI.
