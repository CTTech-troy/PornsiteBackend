import { Router } from 'express';
import { requireAdminAuth } from '../middleware/adminAuth.js';
import {
  adjustAdminCoinWallet,
  createAdminCoinPackage,
  deleteAdminCoinPackage,
  createAdminGiftCatalogItem,
  deleteAdminGiftCatalogItem,
  getAdminCoinAnalytics,
  getAdminGiftCatalog,
  getAdminCoinPackages,
  toggleAdminGiftCatalogItem,
  updateAdminGiftCatalogItem,
  getAdminCoinTransactions,
  getAdminCoinWallet,
  toggleAdminCoinPackage,
  updateAdminCoinPackage,
} from '../controller/coins.controller.js';

const router = Router();

router.use(requireAdminAuth);

router.get('/analytics', getAdminCoinAnalytics);
router.get('/gifts', getAdminGiftCatalog);
router.post('/gifts', createAdminGiftCatalogItem);
router.put('/gifts/:id', updateAdminGiftCatalogItem);
router.patch('/gifts/:id/toggle', toggleAdminGiftCatalogItem);
router.delete('/gifts/:id', deleteAdminGiftCatalogItem);
router.get('/packages', getAdminCoinPackages);
router.post('/packages', createAdminCoinPackage);
router.put('/packages/:id', updateAdminCoinPackage);
router.patch('/packages/:id/toggle', toggleAdminCoinPackage);
router.delete('/packages/:id', deleteAdminCoinPackage);
router.get('/wallets/:userId', getAdminCoinWallet);
router.post('/wallets/:userId/adjust', adjustAdminCoinWallet);
router.get('/transactions', getAdminCoinTransactions);
router.get('/transactions/:userId', getAdminCoinTransactions);

export default router;
