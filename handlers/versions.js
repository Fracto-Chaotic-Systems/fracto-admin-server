import {spawn_sync} from "../../../utils.js";
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs'

const SEPARATOR = path.sep;

export const handle_version = async (req, res) => {
   const service_name = (req.query.service_name)
   const __filename = fileURLToPath(import.meta.url);
   const __dirname = path.dirname(__filename);
   const root_folder_length = __dirname.indexOf('servers')
   const root_folder = __dirname.slice(0, root_folder_length)
   const response = {}
   try {
      const true_folder_name = root_folder.replaceAll('\\', SEPARATOR)
      const log_folder_name = `${true_folder_name}${SEPARATOR}logs`
      const logfile_name = `${log_folder_name}${SEPARATOR}${service_name}-git.txt`
      const service_folder = `${true_folder_name}${SEPARATOR}servers${SEPARATOR}${service_name}`
      spawn_sync('git', ['status', `>${logfile_name}`], service_folder);
      const file_data = fs.readFileSync(logfile_name)
      response[service_name] = file_data.toString('utf8')
      res.json(response)
   } catch (e) {
      console.error("Error getting version status:", err);
      res.error(err);
   }
}
