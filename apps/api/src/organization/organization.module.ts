/*
 * Copyright 2025 Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { RegionModule } from '../region/region.module'
import { RedisLockProvider } from '../sandbox/common/redis-lock.provider'
import { Sandbox } from '../sandbox/entities/sandbox.entity'
import { SnapshotRunner } from '../sandbox/entities/snapshot-runner.entity'
import { Snapshot } from '../sandbox/entities/snapshot.entity'
import { Volume } from '../sandbox/entities/volume.entity'
import { UserModule } from '../user/user.module'
import { OrganizationInvitationController } from './controllers/organization-invitation.controller'
import { OrganizationRoleController } from './controllers/organization-role.controller'
import { OrganizationUserController } from './controllers/organization-user.controller'
import { OrganizationController } from './controllers/organization.controller'
import { RegionController } from './controllers/region.controller'
import { OrganizationInvitation } from './entities/organization-invitation.entity'
import { OrganizationRole } from './entities/organization-role.entity'
import { OrganizationUser } from './entities/organization-user.entity'
import { Organization } from './entities/organization.entity'
import { RegionQuota } from './entities/region-quota.entity'
import { OrganizationInvitationService } from './services/organization-invitation.service'
import { OrganizationRoleService } from './services/organization-role.service'
import { OrganizationUsageService } from './services/organization-usage.service'
import { OrganizationUserService } from './services/organization-user.service'
import { OrganizationService } from './services/organization.service'

@Module({
  imports: [
    UserModule,
    RegionModule,
    TypeOrmModule.forFeature([
      Organization,
      OrganizationRole,
      OrganizationUser,
      OrganizationInvitation,
      Sandbox,
      Snapshot,
      Volume,
      SnapshotRunner,
      RegionQuota,
    ]),
  ],
  controllers: [
    OrganizationController,
    OrganizationRoleController,
    OrganizationUserController,
    OrganizationInvitationController,
    RegionController,
  ],
  providers: [
    OrganizationService,
    OrganizationRoleService,
    OrganizationUserService,
    OrganizationInvitationService,
    OrganizationUsageService,
    RedisLockProvider,
  ],
  exports: [
    OrganizationService,
    OrganizationRoleService,
    OrganizationUserService,
    OrganizationInvitationService,
    OrganizationUsageService,
  ],
})
export class OrganizationModule {}
