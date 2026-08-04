# App CEI Ângela Amin

Aplicativo web para a creche se comunicar com as famílias: chat por turma, cardápio diário e prestação de contas financeira.

## Funcionalidades

- **Login com papéis**: Professor(a), Responsável (pai/mãe), Cozinha e Direção. Contas de equipe exigem um "código da equipe" para evitar cadastros indevidos.
- **Turmas com link de convite**: o(a) professor(a) cria a turma e recebe um link (`/?invite=CODIGO`). Quem entra pelo link se cadastra/loga como responsável e informa o nome da criança.
- **Identificação de quem é quem**: dentro de cada turma há uma lista "Quem é quem" mostrando cada participante, seu papel (badge colorido) e, no caso dos responsáveis, o nome da criança.
- **Chat em tempo real por turma** (Socket.IO): mensagens de texto, com nome, papel e horário de quem enviou.
- **Fotos e PDFs no chat, sem download fácil**: os arquivos são servidos apenas para membros da turma, sempre "inline" (nunca como anexo/download). Imagens abrem em um visualizador dentro do app; PDFs são renderizados página a página em `<canvas>` via PDF.js, sem usar o leitor nativo do navegador (que teria botão de salvar). O menu de clique-direito é bloqueado nas imagens/PDFs.

  ⚠️ **Importante**: isso reduz bastante a facilidade de salvar os arquivos, mas nenhum app web consegue impedir 100% um print/captura de tela. Trate como uma barreira razoável, não como criptografia militar.
- **Cardápio diário**: cozinha, professores ou direção registram o que foi oferecido em cada refeição (café da manhã, lanche, almoço, jantar) por data. Todos podem consultar por dia.
- **Financeiro simples**: lançamentos de receitas e despesas com saldo calculado automaticamente. Professores e direção lançam; qualquer pessoa logada pode visualizar (transparência com as famílias); só a Direção pode excluir lançamentos.
- **Logo da creche** no topo do app e na tela de login (recriação em SVG das cores/estilo do logo enviado — veja nota abaixo).

## Como rodar localmente

Pré-requisitos: [Node.js](https://nodejs.org) versão 18 ou mais recente.

```bash
npm install
npm start
```

Acesse **http://localhost:3000**.

Na primeira vez, crie uma conta de "Direção" ou "Professor(a)" usando o código da equipe padrão:

```
creche2026
```

**Troque esse código antes de usar de verdade**, definindo a variável de ambiente `STAFF_CODE` (veja abaixo).

## Variáveis de ambiente (opcionais)

| Variável         | Para quê serve                                   | Padrão                          |
|------------------|---------------------------------------------------|----------------------------------|
| `PORT`           | Porta do servidor                                  | `3000`                           |
| `SESSION_SECRET` | Chave usada para assinar o cookie de sessão        | valor de exemplo — **troque!**   |
| `STAFF_CODE`     | Código que professores/cozinha/direção usam para se cadastrar | `creche2026` — **troque!** |

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
- `logo.svg` — logo da creche em SVG.
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

O logo que você enviou (casinha sorridente com telhado vermelho e gramado verde, dentro de um círculo, com "CEI Ângela Amin — Centro de Educação Infantil") foi **recriado como um SVG simples** com as mesmas cores e composição, porque este ambiente não conseguiu salvar a imagem original em formato binário. Se quiser usar o arquivo de logo original (PNG/JPG):

1. Salve a imagem original como `logo.png` na mesma pasta dos outros arquivos.
2. No `index.html`, troque as três ocorrências de `/logo.svg` por `/logo.png`.
3. No `server.js`, no objeto `STATIC_FILES`, troque `'/logo.svg': 'logo.svg'` por `'/logo.png': 'logo.png'`.

## Papéis e permissões (resumo)

| Ação                                  | Responsável (pai) | Professor(a) | Cozinha | Direção |
|----------------------------------------|:---:|:---:|:---:|:---:|
| Entrar em turma pelo link              | ✅ | ✅ | ✅ | ✅ |
| Criar turma / gerar convite             | ❌ | ✅ | ❌ | ✅ |
| Enviar mensagens/fotos/PDF no chat      | ✅ | ✅ | ✅ (se estiver na turma) | ✅ |
| Publicar cardápio                       | ❌ | ✅ | ✅ | ✅ |
| Ver cardápio                            | ✅ | ✅ | ✅ | ✅ |
| Lançar receita/despesa                  | ❌ | ✅ | ❌ | ✅ |
| Ver financeiro                          | ✅ | ✅ | ✅ | ✅ |
| Excluir lançamento financeiro           | ❌ | ❌ | ❌ | ✅ |

## Limitações conhecidas (é um app funcional, mas ainda um primeiro passo)

- Sessões ficam em memória: reiniciar o servidor derruba todo mundo logado. Para produção com mais uso, trocar por um "session store" persistente (ex. `connect-sqlite3`) é recomendado.
- Não há recuperação de senha por e-mail (seria o próximo passo natural).
- Não há envio de notificação push quando chega mensagem nova — é preciso abrir o app.
- Bloqueio de download de fotos/PDFs é "best effort" (explicado acima).
