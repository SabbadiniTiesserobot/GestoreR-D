# App gestione R&D sul server interno

Una versione dell'app che gira dentro la rete aziendale: i dati stanno in una cartella
di un server interno, e chi apre l'indirizzo vede e modifica gli stessi **laser** e gli
stessi **PC** (scheda Gestione PC). Non serve OneDrive né un account Microsoft.

Le **ore** in questa versione non ci sono: sono personali e stanno con l'app del PC su
OneDrive. Per le ore si continua a usare l'app pubblicata su GitHub Pages.

Il codice è lo stesso del repository; i dati no: stanno solo sul server, nella cartella
`server/dati/`, che è esclusa da git.

## Cosa serve

- Un computer o server sempre acceso nella rete aziendale, Windows o Linux.
- [Node.js](https://nodejs.org) 18 o più recente. Nessun'altra libreria da installare.
- La porta scelta (8080 di serie) aperta nel firewall per la rete interna.

## Avviarlo

Dalla cartella del repository:

```
node server/server.js
```

e poi, dai PC della rete, `http://NOME-DEL-SERVER:8080/`.

Impostazioni facoltative, come variabili d'ambiente:

| Variabile  | A cosa serve                                                        | Di serie        |
|------------|---------------------------------------------------------------------|-----------------|
| `PORTA`    | la porta                                                            | `8080`          |
| `DATI`     | la cartella dei dati                                                | `server/dati`   |
| `PASSWORD` | se c'è, il browser la chiede prima di aprire l'app (utente qualsiasi) | nessuna        |
| `COPIE`    | quante copie di sicurezza tenere per ogni file                      | `50`            |

Su Windows, per esempio:

```
set PASSWORD=una-password
set DATI=D:\Dati\GestioneRD
node server\server.js
```

Per farlo partire da solo all'accensione: su Windows come servizio (per esempio con
[NSSM](https://nssm.cc): `nssm install GestioneRD "C:\Program Files\nodejs\node.exe" "C:\...\server\server.js"`),
su Linux con un servizio systemd.

## I dati

- I file sono gli stessi che l'app scriveva su OneDrive, con gli stessi nomi:
  `DATI/App gestione R&D/pc_commesse.json` e `DATI/App gestione R&D/laser_servo_robot.json`.
  Per partire con i PC che hai già, copia `pc_commesse.json` dalla cartella
  `OneDrive\App gestione R&D\` in `DATI\App gestione R&D\` prima del primo avvio.
- Ogni scrittura passa da un file temporaneo e poi si rinomina: un file non resta mai a
  metà. La versione di prima finisce in `DATI/.copie/`, e se ne tengono le ultime `COPIE`.
- Se due persone salvano insieme, la seconda non sovrascrive la prima: l'app rilegge il
  file, unisce le modifiche PC per PC e riprova.
- Conviene comunque includere la cartella `DATI` nel backup del server.

## Da sapere

- Senza `PASSWORD`, chiunque nella rete interna arrivi all'indirizzo può vedere e
  modificare i dati. Con la password, la chiede il browser una volta e poi la ricorda.
- Su `http://` (senza https) il browser non attiva la parte offline dell'app: serve la
  rete aziendale per usarla. Tutto il resto funziona.
- Il server serve solo i file dell'app e l'API dei dati: niente elenchi di cartelle e
  niente altri file.
