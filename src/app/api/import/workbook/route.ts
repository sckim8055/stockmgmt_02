import { handleWorkbookImport, workbookTemplateResponse } from '@/lib/import/http';
import { route } from '@/lib/http/route';

// 통합 파일 엑셀 업로드(직원·자산·주변기기 시트를 한 파일로). GET 은 빈 양식, POST 는 미리보기(?mode=preview) 또는 반영(?mode=commit).
//
// 권한 선언에 대해: 이 라우트에 필요한 권한은 파일에 든 시트에 따라 달라서(직원 시트 → master.person:import,
// 자산 시트 → asset.item:import, 주변기기 시트 → peripheral.receive:execute) route() 의 권한 하나로는 정확히 적을 수 없다.
// 그래서 자산 업로드 권한(asset.item:import)을 선언한다. 통합 파일의 중심이 자산 시트이고, 선언이 종류별 업로드의
// 어느 선언보다도 약하지 않게 하기 위해서다(권한이 없는 계정은 파일을 받기도 전에 403).
// 시트마다의 권한(업로드 권한 + 등록·배정·상태 처리 권한)은 runWorkbookImport 가 시트마다 따로 확인한다.
// 그 결과: 직원 업로드나 주변기기 입고 권한만 있고 자산 업로드 권한이 없는 계정은 통합 파일을 쓸 수 없고,
// 종류별 업로드를 쓴다(권한을 넓히는 쪽이 아니라 좁히는 쪽으로 어긋난다).
export const GET = route(
  { access: 'permission', permission: { resource: 'asset.item', operation: 'import' } },
  async () => workbookTemplateResponse(),
);

export const POST = route(
  { access: 'permission', permission: { resource: 'asset.item', operation: 'import' } },
  async ({ req, actor, tenant }) => handleWorkbookImport(req, actor(), tenant),
);
