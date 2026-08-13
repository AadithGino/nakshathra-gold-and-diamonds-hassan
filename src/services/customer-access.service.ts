import { AppError } from '../utils/AppError.js';
import { Customer } from '../models/index.js';

export async function getOwnedCustomer(userId: string) {
  const customer = await Customer.findOne({ userId })
    .select('-aadhaar')
    .populate('userId', 'name phone')
    .populate('nomineeId');
  if (!customer) {
    throw new AppError('CUSTOMER_NOT_FOUND', 'Customer profile not found', 404);
  }
  return customer;
}
