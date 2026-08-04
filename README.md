# App CEI Ângela Amin

Aplicativo web para a creche se comunicar com as famílias: chat por turma, cardápio diário e prestação de contas financeira.

## Funcionalidades

- **Login com 9 papéis**: Responsável (pai/mãe), Estagiária, Professora Regente, Professora Auxiliar, Cozinha, Diretora, Coordenadora Pedagógica, Secretária e Gestor. Contas de equipe (todas menos Responsável) exigem um "código da equipe" para evitar cadastros indevidos.
- **Turmas com link de convite**: professoras regentes/auxiliares e a direção criam a turma e recebem um link (`/?invite=CODIGO`). Quem entra pelo link se cadastra/loga como responsável e informa o nome da criança.
- **Identificação de quem é quem**: dentro de cada turma há uma lista "Quem é quem" mostrando cada participante, seu papel (badge colorido) e, no caso dos responsáveis, o nome da criança.
- **Chat em tempo real por turma** (Socket.IO): mensagens de texto, com nome, papel e horário de quem enviou.
- **Fotos e PDFs no chat, sem download fácil**: os arquivos são servidos apenas para membros da turma, sempre "inline" (nunca como anexo/download). Imagens abrem em um visualizador dentro do app; PDFs são renderizados página a página em `<canvas>` via PDF.js, sem usar o leitor nativo do navegador (que teria botão de salvar). O menu de clique-direito é bloqueado nas imagens/PDFs.

  ⚠️ **Importante**: isso reduz bastante a facilidade de salvar os arquivos, mas nenhum app web consegue impedir 100% um print/captura de tela. Trate como uma barreira razoável, não como criptografia militar.
- **Mensagens privadas**: responsáveis podem abrir uma conversa 1:1 com as professoras/estagiária da turma do filho e com qualquer pessoa da direção. **Nunca é permitida conversa privada entre dois responsáveis.** A equipe também pode conversar livremente entre si. Suporta foto/PDF igual ao chat da turma (visualização dentro do app, sem download).
- **Apagar mensagens na turma**: qualquer pessoa pode apagar a própria mensagem; a professora regente e qualquer pessoa da direção também podem apagar mensagens enviadas por outras pessoas no chat da turma (fica registrado "Mensagem removida por Fulana"). Nas conversas privadas, só quem enviou pode apagar a própria mensagem.
- **Cardápio diário**: cozinha, professoras (regente/auxiliar/estagiária) ou direção registram o que foi oferecido em cada refeição (Café da Manhã, Almoço, Café da Tarde, Lanche Final) por data. Todos podem consultar por dia.
- **Financeiro simples**: lançamentos de receitas e despesas com saldo calculado automaticamente. Diretora, Gestor e Secretária lançam; qualquer pessoa logada pode visualizar (transparência com as famílias); só Diretora e Gestor podem excluir lançamentos.
- **Logo da creche** no topo do app e na tela de login — usando a arte original que você enviou (recortada e otimizada para web).

## Como rodar localmente

Pré-requisitos: [Node.js](https://nodejs.org) versão 18 ou mais recente.

```bash
npm install
npm start
```

Acesse **http://localhost:3000**.

Na primeira vez, crie uma conta de equipe (ex.: "Diretora") usando o código da equipe padrão:

```
creche2026
```

**Troque esse código antes de usar de verdade**, definindo a variável de ambiente `STAFF_CODE` (veja abaixo).

## Variáveis de ambiente (opcionais)

| Variável         | Para quê serve                                   | Padrão                          |
|------------------|---------------------------------------------------|----------------------------------|
| `PORT`           | Porta do servidor                                  | `3000`                           |
| `SESSION_SECRET` | Chave usada para assinar o cookie de sessão        | valor de exemplo — **troque!**   |
| `STAFF_CODE`     | Código que toda a equipe (não-responsáveis) usa para se cadastrar | `creche2026` — **troque!** |

Exemplo:
```bash
PORT=3000 SESSION_SECRET="uma-chave-bem-aleatoria" STAFF_CODE="minha-creche-2026" npm start
```

## Como disponibilizar para as famílias (fora do seu computador)

Hoje o app roda como um servidor único (Node + SQLite). Para pais e professores acessarem de casa/celular, ele precisa estar hospedado em algum lugar acessível pela internet. Algumas opções simples e de baixo custo:

1. **Render.com / Railway.app** — conecte este código a um repositório Git, escolha "Web Service" Node, defina as variáveis de ambiente acima, e pronto: você recebe uma URL pública (ex.: `https://cei-angela-amin.onrender.com`).
2. **Um VPS simples** (ex.: uma máquina pequena na DigitalOcean/Hetzner) rodando `npm start` com um gerenciador de processos como `pm2`, atrás de um proxy HTTPS (Nginx + Let's Encrypt).
3. Para testes internos na mesma rede Wi-Fi da creche, dá pra rodar localmente e acessar pelo IP da máquina (ex. `http://192.168.0.10:3000`) — mas isso não funciona fora da rede.

Ao publicar com HTTPS, adicione em `server.js` (procure pelo trecho `const sessionMiddleware = session({...})`) a opção `cookie: { secure: true }` e, logo acima de `app.use(sessionMiddleware)`, a linha `app.set('trust proxy', 1)` — isso é necessário para os cookies de login funcionarem corretamente atrás de HTTPS.

## Estrutura dos arquivos

Como o projeto foi criado dentro de uma pasta de saída sem subpastas, todos os arquivos ficam juntos na raiz:

- `server.js` — todo o backend (Express + Socket.IO + SQLite + rotas).
- `index.html`, `style.css`, `app.js` — o front-end (uma única página).
- `logo.png` — logotipo completo (ícone + nome), usado na tela de login.
- `logo-icon.png` — só o ícone circular, usado no topo do app e como ícone do site.
- `package.json` — dependências do projeto.
- `data/` e `uploads/` — criadas automaticamente ao rodar (banco SQLite e arquivos enviados no chat). **Não vá para o Git** — já é comum ignorá-las (veja abaixo).

Se quiser organizar em pastas (`server/`, `public/`) no seu computador, sinta-se à vontade — o código não depende de nomes de pasta específicos, só do `require`/caminhos usados hoje.

Sugestão de `.gitignore` caso publique num repositório:
```
node_modules/
data/
uploads/
```

## Sobre o logo

`logo.png` e `logo-icon.png` foram recortados diretamente do arquivo original que você enviou (`03 logotipo_vertical_com_fundo.png`), então é exatamente a sua arte — só redimensionada/otimizada para carregar rápido no navegador.

## Papéis e permissões (resumo)

| Ação | Responsável | Estagiária | Prof. Regente | Prof. Auxiliar | Cozinha | Diretora | Coord. Pedagógica | Secretária | Gestor |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| Entrar em turma pelo link       | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Criar turma / gerar convite     | ❌ | ❌ | ✅ | ✅ | ❌ | ✅ | ✅ | ❌ | ✅ |
| Enviar mensagens/fotos/PDF no chat | ✅ | ✅ (se estiver na turma) | ✅ | ✅ | ✅ (se estiver na turma) | ✅ | ✅ | ✅ (se estiver na turma) | ✅ |
| Publicar cardápio               | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ |
| Ver cardápio                    | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Remover item do cardápio de outra pessoa | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ | ❌ | ✅ |
| Lançar receita/despesa          | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ | ✅ | ✅ |
| Ver financeiro                  | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Excluir lançamento financeiro   | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ | ✅ |

Quem sempre pode enviar mensagens no chat: qualquer pessoa que seja membro daquela turma (entrou pelo link de convite ou foi quem criou a turma).

### Regra das mensagens privadas

- Responsável ↔ Direção (Diretora, Coordenadora Pedagógica, Secretária, Gestor): sempre pode, mesmo sem estarem na mesma turma.
- Responsável ↔ Professora Regente / Professora Auxiliar / Estagiária: só se essa pessoa da equipe estiver na(s) mesma(s) turma(s) que o responsável (ou seja, é professora do filho dela).
- Responsável ↔ Responsável: **nunca permitido.**
- Equipe ↔ Equipe (qualquer combinação de cargos da equipe): sempre pode.

### Apagar mensagens

- Chat da turma: dono da mensagem, professora regente ou qualquer pessoa da direção.
- Conversa privada: só quem enviou a mensagem.
- A mensagem não some do banco de dados — ela fica marcada como removida e aparece como "Mensagem removida" para preservar o histórico da conversa.

Achou alguma dessas regras diferente do que sua creche precisa? É só pedir — dá pra ajustar cada linha dessa tabela facilmente no código (`server.js`, no topo, tem as listas `TURMA_CREATE_ROLES`, `CARDAPIO_ROLES`, `FIN_MANAGE_ROLES` etc.).

## Limitações conhecidas (é um app funcional, mas ainda um primeiro passo)

- Sessões ficam em memória: reiniciar o servidor derruba todo mundo logado. Para produção com mais uso, trocar por um "session store" persistente (ex. `connect-sqlite3`) é recomendado.
- Não há recuperação de senha por e-mail (seria o próximo passo natural).
- Não há envio de notificação push quando chega mensagem nova — é preciso abrir o app.
- Bloqueio de download de fotos/PDFs é "best effort" (explicado acima).
