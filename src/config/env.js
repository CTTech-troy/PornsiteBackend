import dotenv from 'dotenv';

process.env.DOTENV_CONFIG_QUIET = process.env.DOTENV_CONFIG_QUIET || 'true';

dotenv.config({ quiet: true });
