import express from 'express'
import chalk from "chalk";
const FRACTO_ADMIN_PORT = Number(process.env.FRACTO_ADMIN_PORT || 3005);

import {handle_main_status} from "./handlers/status.js";
import {handle_logs} from "./handlers/logs.js";
import {handle_version} from "./handlers/versions.js";
import {handle_commits} from "./handlers/commits.js";
import {handle_social} from "./handlers/social.js";
import {handle_ports} from "./handlers/ports.js";
import {handle_login_events, handle_user_update, handle_users} from "./handlers/users.js";

const app = express();

const configured_ui_origin = process.env.FRACTO_UI_ORIGIN || `http://localhost:${process.env.FRACTO_UI_PORT || 3006}`;
app.use((req, res, next) => {
   const request_origin = req.headers.origin;
   const allow_all_origins = process.env.FRACTO_ALLOW_CORS_ALL === 'true';
   const allow_credentials = Boolean(request_origin && (allow_all_origins || request_origin === configured_ui_origin));
   res.setHeader('Access-Control-Allow-Origin', allow_credentials ? request_origin : '*');
   res.vary('Origin');
   res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
   res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Requested-With');
   if (allow_credentials) res.setHeader('Access-Control-Allow-Credentials', 'true');
   if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
   }
   next();
});

app.use(express.json());

// Start the server and listen for incoming requests
app.listen(FRACTO_ADMIN_PORT, () => {
   console.log(chalk.green(`fracto-admin-server is running on http://localhost:${FRACTO_ADMIN_PORT}`));
});

app.get('/', handle_main_status)
app.get('/logs', handle_logs)
app.get('/version', handle_version)
app.get('/commits', handle_commits)
app.get('/social', handle_social)
app.get('/ports', handle_ports)
app.get('/users', handle_users)
app.get('/login_events', handle_login_events)
app.put('/users/:id', express.json(), handle_user_update)
