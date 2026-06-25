import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding database...');

  // Create default admin user
  const adminPassword = await bcrypt.hash('Admin@Seplati2024', 12);

  const admin = await prisma.user.upsert({
    where: { email: 'admin@seplati.gov.br' },
    update: {},
    create: {
      name: 'Administrador Seplati',
      email: 'admin@seplati.gov.br',
      passwordHash: adminPassword,
      role: 'ADMIN',
    },
  });

  console.log(`✅ Admin user created: ${admin.email}`);
  console.log('⚠️  IMPORTANT: Change the admin password after first login!');
}

main()
  .catch((e) => {
    console.error('❌ Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
