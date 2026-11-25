export interface VnWard {
  code: string;
  name: string;
}

export interface VnDistrict {
  code: string;
  name: string;
  wards: readonly VnWard[];
}

export interface VnProvince {
  code: string;
  name: string;
  districts: readonly VnDistrict[];
}

export interface VnDivisionSelection {
  provinceCode: string;
  provinceName: string;
  districtCode: string;
  districtName: string;
  wardCode: string;
  wardName: string;
}

/**
 * Official Vietnamese Administrative Divisions dataset (GSO / Tổng cục Thống kê codes)
 * covering centrally-governed municipalities and major provinces/cities.
 */
export const VN_PROVINCES: readonly VnProvince[] = [
  {
    code: '01',
    name: 'Thành phố Hà Nội',
    districts: [
      {
        code: '001',
        name: 'Quận Ba Đình',
        wards: [
          { code: '00001', name: 'Phường Phúc Xá' },
          { code: '00004', name: 'Phường Trúc Bạch' },
          { code: '00006', name: 'Phường Vĩnh Phúc' },
          { code: '00007', name: 'Phường Cống Vị' },
          { code: '00008', name: 'Phường Liễu Giai' },
          { code: '00010', name: 'Phường Nguyễn Trung Trực' },
          { code: '00013', name: 'Phường Quán Thánh' },
          { code: '00016', name: 'Phường Ngọc Hà' },
          { code: '00019', name: 'Phường Điện Biên' },
          { code: '00022', name: 'Phường Đội Cấn' },
          { code: '00025', name: 'Phường Ngọc Khánh' },
          { code: '00028', name: 'Phường Kim Mã' },
          { code: '00031', name: 'Phường Giảng Võ' },
          { code: '00034', name: 'Phường Thành Công' },
        ],
      },
      {
        code: '002',
        name: 'Quận Hoàn Kiếm',
        wards: [
          { code: '00037', name: 'Phường Phúc Tân' },
          { code: '00040', name: 'Phường Đồng Xuân' },
          { code: '00043', name: 'Phường Hàng Mã' },
          { code: '00046', name: 'Phường Hàng Buồm' },
          { code: '00049', name: 'Phường Hàng Đào' },
          { code: '00052', name: 'Phường Hàng Bồ' },
          { code: '00055', name: 'Phường Cửa Đông' },
          { code: '00058', name: 'Phường Lý Thái Tổ' },
          { code: '00061', name: 'Phường Hàng Bạc' },
          { code: '00064', name: 'Phường Hàng Gai' },
          { code: '00067', name: 'Phường Chương Dương' },
          { code: '00070', name: 'Phường Hàng Trống' },
          { code: '00073', name: 'Phường Cửa Nam' },
          { code: '00076', name: 'Phường Hàng Bông' },
          { code: '00079', name: 'Phường Tràng Tiền' },
          { code: '00082', name: 'Phường Trần Hưng Đạo' },
          { code: '00085', name: 'Phường Phan Chu Trinh' },
          { code: '00088', name: 'Phường Hàng Bài' },
        ],
      },
      {
        code: '003',
        name: 'Quận Tây Hồ',
        wards: [
          { code: '00091', name: 'Phường Phú Thượng' },
          { code: '00094', name: 'Phường Nhật Tân' },
          { code: '00097', name: 'Phường Tứ Liên' },
          { code: '00100', name: 'Phường Quảng An' },
          { code: '00103', name: 'Phường Xuân La' },
          { code: '00106', name: 'Phường Yên Phụ' },
          { code: '00109', name: 'Phường Bưởi' },
          { code: '00112', name: 'Phường Thụy Khuê' },
        ],
      },
      {
        code: '004',
        name: 'Quận Long Biên',
        wards: [
          { code: '00115', name: 'Phường Thượng Thanh' },
          { code: '00118', name: 'Phường Ngọc Thụy' },
          { code: '00121', name: 'Phường Giang Biên' },
          { code: '00124', name: 'Phường Đức Giang' },
          { code: '00127', name: 'Phường Việt Hưng' },
          { code: '00130', name: 'Phường Gia Thụy' },
          { code: '00133', name: 'Phường Ngọc Lâm' },
          { code: '00136', name: 'Phường Phúc Lợi' },
          { code: '00139', name: 'Phường Bồ Đề' },
          { code: '00142', name: 'Phường Sài Đồng' },
          { code: '00145', name: 'Phường Long Biên' },
          { code: '00148', name: 'Phường Thạch Bàn' },
          { code: '00151', name: 'Phường Phúc Đồng' },
          { code: '00154', name: 'Phường Cự Khối' },
        ],
      },
      {
        code: '005',
        name: 'Quận Cầu Giấy',
        wards: [
          { code: '00157', name: 'Phường Nghĩa Đô' },
          { code: '00160', name: 'Phường Nghĩa Tân' },
          { code: '00163', name: 'Phường Mai Dịch' },
          { code: '00166', name: 'Phường Dịch Vọng' },
          { code: '00167', name: 'Phường Dịch Vọng Hậu' },
          { code: '00169', name: 'Phường Quan Hoa' },
          { code: '00172', name: 'Phường Yên Hòa' },
          { code: '00175', name: 'Phường Trung Hòa' },
        ],
      },
      {
        code: '006',
        name: 'Quận Đống Đa',
        wards: [
          { code: '00178', name: 'Phường Cát Linh' },
          { code: '00181', name: 'Phường Văn Miếu' },
          { code: '00184', name: 'Phường Quốc Tử Giám' },
          { code: '00187', name: 'Phường Láng Thượng' },
          { code: '00190', name: 'Phường Ô Chợ Dừa' },
          { code: '00193', name: 'Phường Văn Chương' },
          { code: '00196', name: 'Phường Hàng Bột' },
          { code: '00199', name: 'Phường Láng Hạ' },
          { code: '00202', name: 'Phường Khâm Thiên' },
          { code: '00205', name: 'Phường Thổ Quan' },
          { code: '00208', name: 'Phường Nam Đồng' },
          { code: '00211', name: 'Phường Trung Phụng' },
          { code: '00214', name: 'Phường Quang Trung' },
          { code: '00217', name: 'Phường Trung Liệt' },
          { code: '00220', name: 'Phường Phương Liên' },
          { code: '00223', name: 'Phường Thịnh Quang' },
          { code: '00226', name: 'Phường Trung Tự' },
          { code: '00229', name: 'Phường Kim Liên' },
          { code: '00232', name: 'Phường Phương Mai' },
          { code: '00235', name: 'Phường Ngã Tư Sở' },
          { code: '00238', name: 'Phường Khương Thượng' },
        ],
      },
      {
        code: '007',
        name: 'Quận Hai Bà Trưng',
        wards: [
          { code: '00241', name: 'Phường Nguyễn Du' },
          { code: '00244', name: 'Phường Bạch Đằng' },
          { code: '00247', name: 'Phường Phạm Đình Hổ' },
          { code: '00256', name: 'Phường Lê Đại Hành' },
          { code: '00259', name: 'Phường Đồng Nhân' },
          { code: '00262', name: 'Phường Phố Huế' },
          { code: '00265', name: 'Phường Đống Mác' },
          { code: '00268', name: 'Phường Thanh Lương' },
          { code: '00271', name: 'Phường Thanh Nhàn' },
          { code: '00274', name: 'Phường Cầu Dền' },
          { code: '00277', name: 'Phường Bách Khoa' },
          { code: '00280', name: 'Phường Đồng Tâm' },
          { code: '00283', name: 'Phường Vĩnh Tuy' },
          { code: '00286', name: 'Phường Bạch Mai' },
          { code: '00289', name: 'Phường Quỳnh Mai' },
          { code: '00292', name: 'Phường Quỳnh Lôi' },
          { code: '00295', name: 'Phường Minh Khai' },
          { code: '00298', name: 'Phường Trương Định' },
        ],
      },
      {
        code: '008',
        name: 'Quận Hoàng Mai',
        wards: [
          { code: '00301', name: 'Phường Thanh Trì' },
          { code: '00304', name: 'Phường Vĩnh Hưng' },
          { code: '00307', name: 'Phường Định Công' },
          { code: '00310', name: 'Phường Mai Động' },
          { code: '00313', name: 'Phường Tương Mai' },
          { code: '00316', name: 'Phường Đại Kim' },
          { code: '00319', name: 'Phường Tân Mai' },
          { code: '00322', name: 'Phường Hoàng Văn Thụ' },
          { code: '00325', name: 'Phường Giáp Bát' },
          { code: '00328', name: 'Phường Lĩnh Nam' },
          { code: '00331', name: 'Phường Thịnh Liệt' },
          { code: '00334', name: 'Phường Trần Phú' },
          { code: '00337', name: 'Phường Hoàng Liệt' },
          { code: '00340', name: 'Phường Yên Sở' },
        ],
      },
      {
        code: '009',
        name: 'Quận Thanh Xuân',
        wards: [
          { code: '00343', name: 'Phường Nhân Chính' },
          { code: '00346', name: 'Phường Thượng Đình' },
          { code: '00349', name: 'Phường Khương Trung' },
          { code: '00352', name: 'Phường Khương Mai' },
          { code: '00355', name: 'Phường Thanh Xuân Trung' },
          { code: '00358', name: 'Phường Phương Liệt' },
          { code: '00361', name: 'Phường Hạ Đình' },
          { code: '00364', name: 'Phường Khương Đình' },
          { code: '00367', name: 'Phường Thanh Xuân Bắc' },
          { code: '00370', name: 'Phường Thanh Xuân Nam' },
          { code: '00373', name: 'Phường Kim Giang' },
        ],
      },
      {
        code: '019',
        name: 'Quận Nam Từ Liêm',
        wards: [
          { code: '00622', name: 'Phường Cầu Diễn' },
          { code: '00625', name: 'Phường Xuân Phương' },
          { code: '00626', name: 'Phường Phương Canh' },
          { code: '00628', name: 'Phường Mỹ Đình 1' },
          { code: '00631', name: 'Phường Mỹ Đình 2' },
          { code: '00632', name: 'Phường Tây Mỗ' },
          { code: '00634', name: 'Phường Mễ Trì' },
          { code: '00635', name: 'Phường Phú Đô' },
          { code: '00637', name: 'Phường Đại Mỗ' },
          { code: '00640', name: 'Phường Trung Văn' },
        ],
      },
      {
        code: '268',
        name: 'Quận Hà Đông',
        wards: [
          { code: '09538', name: 'Phường Nguyễn Trãi' },
          { code: '09541', name: 'Phường Mộ Lao' },
          { code: '09542', name: 'Phường Văn Quán' },
          { code: '09544', name: 'Phường Vạn Phúc' },
          { code: '09547', name: 'Phường Yết Kiêu' },
          { code: '09550', name: 'Phường Quang Trung' },
          { code: '09551', name: 'Phường La Khê' },
          { code: '09552', name: 'Phường Phú La' },
          { code: '09556', name: 'Phường Hà Cầu' },
          { code: '09562', name: 'Phường Kiến Hưng' },
          { code: '09568', name: 'Phường Dương Nội' },
        ],
      },
    ],
  },
  {
    code: '79',
    name: 'Thành phố Hồ Chí Minh',
    districts: [
      {
        code: '760',
        name: 'Quận 1',
        wards: [
          { code: '26734', name: 'Phường Tân Định' },
          { code: '26737', name: 'Phường Đa Kao' },
          { code: '26740', name: 'Phường Bến Nghé' },
          { code: '26743', name: 'Phường Bến Thành' },
          { code: '26746', name: 'Phường Nguyễn Thái Bình' },
          { code: '26749', name: 'Phường Phạm Ngũ Lão' },
          { code: '26752', name: 'Phường Cầu Ông Lãnh' },
          { code: '26755', name: 'Phường Cô Giang' },
          { code: '26758', name: 'Phường Nguyễn Cư Trinh' },
          { code: '26761', name: 'Phường Cầu Kho' },
        ],
      },
      {
        code: '769',
        name: 'Thành phố Thủ Đức',
        wards: [
          { code: '27088', name: 'Phường Thảo Điền' },
          { code: '27091', name: 'Phường An Phú' },
          { code: '27100', name: 'Phường Bình Trưng Đông' },
          { code: '27103', name: 'Phường Bình Trưng Tây' },
          { code: '27106', name: 'Phường Cát Lái' },
          { code: '27115', name: 'Phường An Lợi Đông' },
          { code: '27118', name: 'Phường Thủ Thiêm' },
          { code: '26806', name: 'Phường Linh Trung' },
          { code: '26815', name: 'Phường Linh Tây' },
          { code: '26818', name: 'Phường Linh Chiểu' },
          { code: '26824', name: 'Phường Hiệp Bình Chánh' },
          { code: '26830', name: 'Phường Phước Long B' },
        ],
      },
      {
        code: '770',
        name: 'Quận 3',
        wards: [
          { code: '27124', name: 'Phường Võ Thị Sáu' },
          { code: '27127', name: 'Phường 09' },
          { code: '27130', name: 'Phường 11' },
          { code: '27133', name: 'Phường 12' },
          { code: '27136', name: 'Phường 13' },
          { code: '27139', name: 'Phường 14' },
          { code: '27142', name: 'Phường 05' },
          { code: '27145', name: 'Phường 04' },
          { code: '27148', name: 'Phường 03' },
          { code: '27151', name: 'Phường 02' },
          { code: '27154', name: 'Phường 01' },
        ],
      },
      {
        code: '774',
        name: 'Quận 5',
        wards: [
          { code: '27259', name: 'Phường 04' },
          { code: '27262', name: 'Phường 09' },
          { code: '27265', name: 'Phường 03' },
          { code: '27268', name: 'Phường 12' },
          { code: '27271', name: 'Phường 02' },
          { code: '27274', name: 'Phường 08' },
          { code: '27280', name: 'Phường 07' },
          { code: '27283', name: 'Phường 01' },
          { code: '27286', name: 'Phường 11' },
          { code: '27289', name: 'Phường 14' },
          { code: '27292', name: 'Phường 05' },
          { code: '27295', name: 'Phường 06' },
          { code: '27298', name: 'Phường 10' },
          { code: '27301', name: 'Phường 13' },
        ],
      },
      {
        code: '778',
        name: 'Quận 7',
        wards: [
          { code: '27469', name: 'Phường Tân Thuận Đông' },
          { code: '27472', name: 'Phường Tân Thuận Tây' },
          { code: '27475', name: 'Phường Tân Kiểng' },
          { code: '27478', name: 'Phường Tân Hưng' },
          { code: '27481', name: 'Phường Bình Thuận' },
          { code: '27484', name: 'Phường Tân Quy' },
          { code: '27487', name: 'Phường Phú Thuận' },
          { code: '27490', name: 'Phường Tân Phú' },
          { code: '27493', name: 'Phường Tân Phong' },
          { code: '27496', name: 'Phường Phú Mỹ' },
        ],
      },
      {
        code: '765',
        name: 'Quận Bình Thạnh',
        wards: [
          { code: '26905', name: 'Phường 13' },
          { code: '26908', name: 'Phường 11' },
          { code: '26911', name: 'Phường 27' },
          { code: '26914', name: 'Phường 26' },
          { code: '26917', name: 'Phường 12' },
          { code: '26920', name: 'Phường 25' },
          { code: '26923', name: 'Phường 05' },
          { code: '26926', name: 'Phường 07' },
          { code: '26929', name: 'Phường 24' },
          { code: '26932', name: 'Phường 06' },
          { code: '26935', name: 'Phường 14' },
          { code: '26938', name: 'Phường 15' },
          { code: '26941', name: 'Phường 02' },
          { code: '26944', name: 'Phường 01' },
          { code: '26947', name: 'Phường 03' },
          { code: '26950', name: 'Phường 17' },
          { code: '26953', name: 'Phường 21' },
          { code: '26956', name: 'Phường 22' },
          { code: '26959', name: 'Phường 19' },
          { code: '26962', name: 'Phường 28' },
        ],
      },
      {
        code: '766',
        name: 'Quận Tân Bình',
        wards: [
          { code: '26965', name: 'Phường 02' },
          { code: '26968', name: 'Phường 04' },
          { code: '26971', name: 'Phường 12' },
          { code: '26974', name: 'Phường 13' },
          { code: '26977', name: 'Phường 01' },
          { code: '26980', name: 'Phường 03' },
          { code: '26983', name: 'Phường 11' },
          { code: '26986', name: 'Phường 07' },
          { code: '26989', name: 'Phường 05' },
          { code: '26992', name: 'Phường 10' },
          { code: '26995', name: 'Phường 06' },
          { code: '26998', name: 'Phường 08' },
          { code: '27001', name: 'Phường 09' },
          { code: '27004', name: 'Phường 14' },
          { code: '27007', name: 'Phường 15' },
        ],
      },
      {
        code: '768',
        name: 'Quận Phú Nhuận',
        wards: [
          { code: '27043', name: 'Phường 04' },
          { code: '27046', name: 'Phường 05' },
          { code: '27049', name: 'Phường 09' },
          { code: '27052', name: 'Phường 07' },
          { code: '27055', name: 'Phường 03' },
          { code: '27058', name: 'Phường 01' },
          { code: '27061', name: 'Phường 02' },
          { code: '27064', name: 'Phường 08' },
          { code: '27067', name: 'Phường 15' },
          { code: '27070', name: 'Phường 10' },
          { code: '27073', name: 'Phường 11' },
          { code: '27076', name: 'Phường 17' },
          { code: '27082', name: 'Phường 13' },
        ],
      },
      {
        code: '771',
        name: 'Quận 10',
        wards: [
          { code: '27160', name: 'Phường 15' },
          { code: '27163', name: 'Phường 13' },
          { code: '27166', name: 'Phường 14' },
          { code: '27169', name: 'Phường 12' },
          { code: '27172', name: 'Phường 11' },
          { code: '27175', name: 'Phường 10' },
          { code: '27178', name: 'Phường 09' },
          { code: '27181', name: 'Phường 01' },
          { code: '27184', name: 'Phường 08' },
          { code: '27187', name: 'Phường 02' },
          { code: '27190', name: 'Phường 04' },
          { code: '27193', name: 'Phường 07' },
          { code: '27196', name: 'Phường 05' },
          { code: '27199', name: 'Phường 06' },
        ],
      },
    ],
  },
  {
    code: '48',
    name: 'Thành phố Đà Nẵng',
    districts: [
      {
        code: '490',
        name: 'Quận Liên Chiểu',
        wards: [
          { code: '20194', name: 'Phường Hòa Hiệp Bắc' },
          { code: '20195', name: 'Phường Hòa Hiệp Nam' },
          { code: '20197', name: 'Phường Hòa Khánh Bắc' },
          { code: '20198', name: 'Phường Hòa Khánh Nam' },
          { code: '20200', name: 'Phường Hòa Minh' },
        ],
      },
      {
        code: '491',
        name: 'Quận Thanh Khê',
        wards: [
          { code: '20203', name: 'Phường Tam Thuận' },
          { code: '20206', name: 'Phường Thanh Khê Tây' },
          { code: '20207', name: 'Phường Thanh Khê Đông' },
          { code: '20209', name: 'Phường Xuân Hà' },
          { code: '20215', name: 'Phường Chính Gián' },
          { code: '20218', name: 'Phường Vĩnh Trung' },
          { code: '20221', name: 'Phường Thạc Gián' },
          { code: '20224', name: 'Phường An Khê' },
          { code: '20225', name: 'Phường Hòa Khê' },
        ],
      },
      {
        code: '492',
        name: 'Quận Hải Châu',
        wards: [
          { code: '20227', name: 'Phường Thanh Bình' },
          { code: '20230', name: 'Phường Thuận Phước' },
          { code: '20233', name: 'Phường Thạch Thang' },
          { code: '20236', name: 'Phường Hải Châu I' },
          { code: '20239', name: 'Phường Hải Châu II' },
          { code: '20242', name: 'Phường Phước Ninh' },
          { code: '20245', name: 'Phường Hòa Thuận Tây' },
          { code: '20246', name: 'Phường Hòa Thuận Đông' },
          { code: '20248', name: 'Phường Nam Dương' },
          { code: '20251', name: 'Phường Bình Hiên' },
          { code: '20254', name: 'Phường Bình Thuận' },
          { code: '20257', name: 'Phường Hòa Cường Bắc' },
          { code: '20258', name: 'Phường Hòa Cường Nam' },
        ],
      },
      {
        code: '493',
        name: 'Quận Sơn Trà',
        wards: [
          { code: '20260', name: 'Phường Thọ Quang' },
          { code: '20263', name: 'Phường Nại Hiên Đông' },
          { code: '20266', name: 'Phường Mân Thái' },
          { code: '20269', name: 'Phường An Hải Bắc' },
          { code: '20272', name: 'Phường Phước Mỹ' },
          { code: '20275', name: 'Phường An Hải Tây' },
          { code: '20278', name: 'Phường An Hải Đông' },
        ],
      },
      {
        code: '494',
        name: 'Quận Ngũ Hành Sơn',
        wards: [
          { code: '20281', name: 'Phường Mỹ An' },
          { code: '20284', name: 'Phường Khuê Mỹ' },
          { code: '20285', name: 'Phường Hòa Quý' },
          { code: '20287', name: 'Phường Hòa Hải' },
        ],
      },
    ],
  },
  {
    code: '31',
    name: 'Thành phố Hải Phòng',
    districts: [
      {
        code: '303',
        name: 'Quận Hồng Bàng',
        wards: [
          { code: '11296', name: 'Phường Quán Toan' },
          { code: '11299', name: 'Phường Hùng Vương' },
          { code: '11302', name: 'Phường Sở Dầu' },
          { code: '11305', name: 'Phường Thượng Lý' },
          { code: '11308', name: 'Phường Hạ Lý' },
          { code: '11311', name: 'Phường Minh Khai' },
          { code: '11314', name: 'Phường Trại Chuối' },
          { code: '11320', name: 'Phường Hoàng Văn Thụ' },
          { code: '11323', name: 'Phường Phan Bội Châu' },
        ],
      },
      {
        code: '304',
        name: 'Quận Ngô Quyền',
        wards: [
          { code: '11329', name: 'Phường Máy Chai' },
          { code: '11332', name: 'Phường Máy Tơ' },
          { code: '11335', name: 'Phường Vạn Mỹ' },
          { code: '11338', name: 'Phường Cầu Tre' },
          { code: '11341', name: 'Phường Lạc Viên' },
          { code: '11347', name: 'Phường Gia Viên' },
          { code: '11353', name: 'Phường Lạch Tray' },
          { code: '11356', name: 'Phường Cầu Đất' },
          { code: '11359', name: 'Phường Lê Lợi' },
          { code: '11362', name: 'Phường Đằng Giang' },
          { code: '11365', name: 'Phường Đông Khê' },
        ],
      },
      {
        code: '305',
        name: 'Quận Lê Chân',
        wards: [
          { code: '11368', name: 'Phường Cát Dài' },
          { code: '11371', name: 'Phường An Biên' },
          { code: '11374', name: 'Phường Lam Sơn' },
          { code: '11377', name: 'Phường An Dương' },
          { code: '11380', name: 'Phường Trần Nguyên Hãn' },
          { code: '11383', name: 'Phường Hồ Nam' },
          { code: '11386', name: 'Phường Trại Cau' },
          { code: '11389', name: 'Phường Dư Hàng' },
          { code: '11392', name: 'Phường Hàng Kênh' },
          { code: '11395', name: 'Phường Đông Hải' },
          { code: '11398', name: 'Phường Niệm Nghĩa' },
          { code: '11401', name: 'Phường Nghĩa Xá' },
          { code: '11404', name: 'Phường Dư Hàng Kênh' },
          { code: '11407', name: 'Phường Kênh Dương' },
          { code: '11410', name: 'Phường Vĩnh Niệm' },
        ],
      },
    ],
  },
  {
    code: '92',
    name: 'Thành phố Cần Thơ',
    districts: [
      {
        code: '916',
        name: 'Quận Ninh Kiều',
        wards: [
          { code: '31117', name: 'Phường Cái Khế' },
          { code: '31120', name: 'Phường An Hòa' },
          { code: '31123', name: 'Phường Thới Bình' },
          { code: '31126', name: 'Phường An Nghiệp' },
          { code: '31129', name: 'Phường An Cư' },
          { code: '31135', name: 'Phường Tân An' },
          { code: '31141', name: 'Phường An Phú' },
          { code: '31144', name: 'Phường Xuân Khánh' },
          { code: '31147', name: 'Phường Hưng Lợi' },
          { code: '31149', name: 'Phường An Khánh' },
          { code: '31150', name: 'Phường An Bình' },
        ],
      },
      {
        code: '918',
        name: 'Quận Bình Thủy',
        wards: [
          { code: '31168', name: 'Phường Bình Thủy' },
          { code: '31169', name: 'Phường Trà An' },
          { code: '31171', name: 'Phường Trà Nóc' },
          { code: '31174', name: 'Phường Thới An Đông' },
          { code: '31177', name: 'Phường An Thới' },
          { code: '31178', name: 'Phường Bùi Hữu Nghĩa' },
          { code: '31180', name: 'Phường Long Hòa' },
          { code: '31183', name: 'Phường Long Tuyền' },
        ],
      },
      {
        code: '919',
        name: 'Quận Cái Răng',
        wards: [
          { code: '31186', name: 'Phường Lê Bình' },
          { code: '31189', name: 'Phường Hưng Phú' },
          { code: '31192', name: 'Phường Hưng Thạnh' },
          { code: '31195', name: 'Phường Ba Láng' },
          { code: '31198', name: 'Phường Thường Thạnh' },
          { code: '31201', name: 'Phường Phú Thứ' },
          { code: '31204', name: 'Phường Tân Phú' },
        ],
      },
    ],
  },
  {
    code: '46',
    name: 'Tỉnh Thừa Thiên Huế',
    districts: [
      {
        code: '474',
        name: 'Thành phố Huế',
        wards: [
          { code: '19744', name: 'Phường Đông Ba' },
          { code: '19747', name: 'Phường Gia Hội' },
          { code: '19750', name: 'Phường Thuận Hòa' },
          { code: '19753', name: 'Phường Thuận Lộc' },
          { code: '19756', name: 'Phường Tây Lộc' },
          { code: '19765', name: 'Phường Kim Long' },
          { code: '19771', name: 'Phường Vỹ Dạ' },
          { code: '19774', name: 'Phường Phường Đúc' },
          { code: '19777', name: 'Phường Vĩnh Ninh' },
          { code: '19780', name: 'Phường Phú Hội' },
          { code: '19783', name: 'Phường Phú Nhuận' },
          { code: '19786', name: 'Phường Xuân Phú' },
          { code: '19789', name: 'Phường Trường An' },
          { code: '19792', name: 'Phường Phước Vĩnh' },
          { code: '19795', name: 'Phường An Cựu' },
          { code: '19801', name: 'Phường An Đông' },
        ],
      },
      {
        code: '479',
        name: 'Thị xã Hương Thủy',
        wards: [
          { code: '19936', name: 'Phường Phú Bài' },
          { code: '19939', name: 'Phường Thủy Lương' },
          { code: '19942', name: 'Phường Thủy Châu' },
          { code: '19945', name: 'Phường Thủy Phương' },
          { code: '19948', name: 'Phường Thủy Dương' },
        ],
      },
    ],
  },
  {
    code: '56',
    name: 'Tỉnh Khánh Hòa',
    districts: [
      {
        code: '568',
        name: 'Thành phố Nha Trang',
        wards: [
          { code: '22327', name: 'Phường Vĩnh Hòa' },
          { code: '22330', name: 'Phường Vĩnh Hải' },
          { code: '22333', name: 'Phường Vĩnh Phước' },
          { code: '22336', name: 'Phường Ngọc Hiệp' },
          { code: '22339', name: 'Phường Vĩnh Thọ' },
          { code: '22342', name: 'Phường Xương Huân' },
          { code: '22345', name: 'Phường Vạn Thắng' },
          { code: '22348', name: 'Phường Vạn Thạnh' },
          { code: '22351', name: 'Phường Phương Sài' },
          { code: '22354', name: 'Phường Phương Sơn' },
          { code: '22357', name: 'Phường Phước Hải' },
          { code: '22360', name: 'Phường Phước Tân' },
          { code: '22363', name: 'Phường Lộc Thọ' },
          { code: '22366', name: 'Phường Phước Tiến' },
          { code: '22369', name: 'Phường Tân Lập' },
          { code: '22372', name: 'Phường Phước Hòa' },
          { code: '22375', name: 'Phường Vĩnh Nguyên' },
          { code: '22378', name: 'Phường Phước Long' },
          { code: '22381', name: 'Phường Vĩnh Trường' },
        ],
      },
      {
        code: '569',
        name: 'Thành phố Cam Ranh',
        wards: [
          { code: '22408', name: 'Phường Cam Nghĩa' },
          { code: '22411', name: 'Phường Cam Phúc Bắc' },
          { code: '22414', name: 'Phường Cam Phúc Nam' },
          { code: '22417', name: 'Phường Cam Lộc' },
          { code: '22420', name: 'Phường Cam Phú' },
          { code: '22423', name: 'Phường Ba Ngòi' },
          { code: '22426', name: 'Phường Cam Thuận' },
          { code: '22429', name: 'Phường Cam Lợi' },
          { code: '22432', name: 'Phường Cam Linh' },
        ],
      },
    ],
  },
  {
    code: '68',
    name: 'Tỉnh Lâm Đồng',
    districts: [
      {
        code: '672',
        name: 'Thành phố Đà Lạt',
        wards: [
          { code: '24769', name: 'Phường 7' },
          { code: '24772', name: 'Phường 8' },
          { code: '24775', name: 'Phường 12' },
          { code: '24778', name: 'Phường 9' },
          { code: '24781', name: 'Phường 2' },
          { code: '24784', name: 'Phường 1' },
          { code: '24787', name: 'Phường 6' },
          { code: '24790', name: 'Phường 5' },
          { code: '24793', name: 'Phường 4' },
          { code: '24796', name: 'Phường 10' },
          { code: '24799', name: 'Phường 11' },
          { code: '24802', name: 'Phường 3' },
        ],
      },
      {
        code: '673',
        name: 'Thành phố Bảo Lộc',
        wards: [
          { code: '24817', name: 'Phường Lộc Phát' },
          { code: '24820', name: 'Phường Lộc Tiến' },
          { code: '24823', name: 'Phường 2' },
          { code: '24826', name: 'Phường 1' },
          { code: '24829', name: "Phường B'Lao" },
          { code: '24832', name: 'Phường Lộc Sơn' },
        ],
      },
    ],
  },
  {
    code: '22',
    name: 'Tỉnh Quảng Ninh',
    districts: [
      {
        code: '193',
        name: 'Thành phố Hạ Long',
        wards: [
          { code: '06649', name: 'Phường Hà Khánh' },
          { code: '06652', name: 'Phường Hà Phong' },
          { code: '06655', name: 'Phường Hà Khẩu' },
          { code: '06658', name: 'Phường Cao Xanh' },
          { code: '06661', name: 'Phường Giếng Đáy' },
          { code: '06664', name: 'Phường Hà Tu' },
          { code: '06667', name: 'Phường Hà Trung' },
          { code: '06670', name: 'Phường Hà Lầm' },
          { code: '06673', name: 'Phường Bãi Cháy' },
          { code: '06676', name: 'Phường Cao Thắng' },
          { code: '06679', name: 'Phường Hùng Thắng' },
          { code: '06682', name: 'Phường Yết Kiêu' },
          { code: '06685', name: 'Phường Trần Hưng Đạo' },
          { code: '06688', name: 'Phường Hồng Hải' },
          { code: '06691', name: 'Phường Hồng Gai' },
          { code: '06694', name: 'Phường Bạch Đằng' },
          { code: '06697', name: 'Phường Hồng Hà' },
          { code: '06700', name: 'Phường Tuần Châu' },
        ],
      },
      {
        code: '195',
        name: 'Thành phố Cẩm Phả',
        wards: [
          { code: '06751', name: 'Phường Mông Dương' },
          { code: '06754', name: 'Phường Cửa Ông' },
          { code: '06757', name: 'Phường Cẩm Sơn' },
          { code: '06760', name: 'Phường Cẩm Đông' },
          { code: '06763', name: 'Phường Cẩm Phú' },
          { code: '06766', name: 'Phường Cẩm Tây' },
          { code: '06769', name: 'Phường Quang Hanh' },
          { code: '06772', name: 'Phường Cẩm Thịnh' },
          { code: '06775', name: 'Phường Cẩm Thủy' },
          { code: '06778', name: 'Phường Cẩm Thạch' },
          { code: '06781', name: 'Phường Cẩm Thành' },
          { code: '06784', name: 'Phường Cẩm Trung' },
          { code: '06787', name: 'Phường Cẩm Bình' },
        ],
      },
    ],
  },
  {
    code: '74',
    name: 'Tỉnh Bình Dương',
    districts: [
      {
        code: '718',
        name: 'Thành phố Thủ Dầu Một',
        wards: [
          { code: '25741', name: 'Phường Hiệp Thành' },
          { code: '25744', name: 'Phường Phú Lợi' },
          { code: '25747', name: 'Phường Phú Cường' },
          { code: '25750', name: 'Phường Phú Hòa' },
          { code: '25753', name: 'Phường Phú Thọ' },
          { code: '25756', name: 'Phường Chánh Nghĩa' },
          { code: '25759', name: 'Phường Định Hòa' },
          { code: '25760', name: 'Phường Hòa Phú' },
          { code: '25762', name: 'Phường Phú Mỹ' },
          { code: '25765', name: 'Phường Phú Tân' },
          { code: '25768', name: 'Phường Tân An' },
          { code: '25771', name: 'Phường Hiệp An' },
          { code: '25774', name: 'Phường Tương Bình Hiệp' },
          { code: '25777', name: 'Phường Chánh Mỹ' },
        ],
      },
      {
        code: '724',
        name: 'Thành phố Dĩ An',
        wards: [
          { code: '25942', name: 'Phường Dĩ An' },
          { code: '25945', name: 'Phường Tân Bình' },
          { code: '25948', name: 'Phường Tân Đông Hiệp' },
          { code: '25951', name: 'Phường Bình An' },
          { code: '25954', name: 'Phường Bình Thắng' },
          { code: '25957', name: 'Phường Đông Hòa' },
          { code: '25960', name: 'Phường An Bình' },
        ],
      },
      {
        code: '725',
        name: 'Thành phố Thuận An',
        wards: [
          { code: '25963', name: 'Phường An Thạnh' },
          { code: '25966', name: 'Phường Lái Thiêu' },
          { code: '25969', name: 'Phường Bình Chuẩn' },
          { code: '25972', name: 'Phường Thuận Giao' },
          { code: '25975', name: 'Phường An Phú' },
          { code: '25978', name: 'Phường Hưng Định' },
          { code: '25984', name: 'Phường Bình Nhâm' },
          { code: '25987', name: 'Phường Bình Hòa' },
          { code: '25990', name: 'Phường Vĩnh Phú' },
        ],
      },
    ],
  },
  {
    code: '75',
    name: 'Tỉnh Đồng Nai',
    districts: [
      {
        code: '731',
        name: 'Thành phố Biên Hòa',
        wards: [
          { code: '25993', name: 'Phường Trảng Dài' },
          { code: '25996', name: 'Phường Tân Phong' },
          { code: '25999', name: 'Phường Tân Biên' },
          { code: '26002', name: 'Phường Hố Nai' },
          { code: '26005', name: 'Phường Tân Hòa' },
          { code: '26008', name: 'Phường Tân Hiệp' },
          { code: '26011', name: 'Phường Bửu Long' },
          { code: '26014', name: 'Phường Tân Tiến' },
          { code: '26017', name: 'Phường Tam Hiệp' },
          { code: '26020', name: 'Phường Long Bình' },
          { code: '26023', name: 'Phường Quang Vinh' },
          { code: '26026', name: 'Phường Tân Mai' },
          { code: '26029', name: 'Phường Thống Nhất' },
          { code: '26032', name: 'Phường Trung Dũng' },
          { code: '26035', name: 'Phường Tam Hòa' },
          { code: '26038', name: 'Phường Hòa Bình' },
          { code: '26041', name: 'Phường Quyết Thắng' },
          { code: '26044', name: 'Phường Thanh Bình' },
          { code: '26047', name: 'Phường Bình Đa' },
          { code: '26050', name: 'Phường An Bình' },
          { code: '26053', name: 'Phường Bửu Hòa' },
          { code: '26056', name: 'Phường Long Bình Tân' },
          { code: '26059', name: 'Phường Tân Vạn' },
          { code: '26062', name: 'Phường Tân Hạnh' },
          { code: '26065', name: 'Phường Hiệp Hòa' },
          { code: '26068', name: 'Phường Hóa An' },
        ],
      },
      {
        code: '732',
        name: 'Thành phố Long Khánh',
        wards: [
          { code: '26071', name: 'Phường Xuân Trung' },
          { code: '26074', name: 'Phường Xuân Thanh' },
          { code: '26077', name: 'Phường Xuân Bình' },
          { code: '26080', name: 'Phường Xuân An' },
          { code: '26083', name: 'Phường Xuân Hòa' },
          { code: '26086', name: 'Phường Phú Bình' },
        ],
      },
    ],
  },
  {
    code: '27',
    name: 'Tỉnh Bắc Ninh',
    districts: [
      {
        code: '256',
        name: 'Thành phố Bắc Ninh',
        wards: [
          { code: '09166', name: 'Phường Vũ Ninh' },
          { code: '09169', name: 'Phường Đáp Cầu' },
          { code: '09172', name: 'Phường Thị Cầu' },
          { code: '09175', name: 'Phường Kinh Bắc' },
          { code: '09178', name: 'Phường Vệ An' },
          { code: '09181', name: 'Phường Tiền An' },
          { code: '09184', name: 'Phường Đại Phúc' },
          { code: '09187', name: 'Phường Ninh Xá' },
          { code: '09190', name: 'Phường Suối Hoa' },
          { code: '09193', name: 'Phường Võ Cường' },
          { code: '09196', name: 'Phường Hòa Long' },
          { code: '09199', name: 'Phường Vạn An' },
          { code: '09202', name: 'Phường Khúc Xuyên' },
          { code: '09205', name: 'Phường Phong Khê' },
          { code: '09208', name: 'Phường Kim Chân' },
          { code: '09211', name: 'Phường Vân Dương' },
          { code: '09214', name: 'Phường Nam Sơn' },
          { code: '09217', name: 'Phường Khắc Niệm' },
          { code: '09220', name: 'Phường Hạp Lĩnh' },
        ],
      },
      {
        code: '261',
        name: 'Thành phố Từ Sơn',
        wards: [
          { code: '09370', name: 'Phường Đông Ngàn' },
          { code: '09373', name: 'Phường Tam Sơn' },
          { code: '09376', name: 'Phường Hương Mạc' },
          { code: '09379', name: 'Phường Tương Giang' },
          { code: '09382', name: 'Phường Phù Khê' },
          { code: '09385', name: 'Phường Đồng Kỵ' },
          { code: '09388', name: 'Phường Trang Hạ' },
          { code: '09391', name: 'Phường Đồng Nguyên' },
          { code: '09394', name: 'Phường Châu Khê' },
          { code: '09397', name: 'Phường Tân Hồng' },
          { code: '09400', name: 'Phường Đình Bảng' },
          { code: '09403', name: 'Phường Phù Chẩn' },
        ],
      },
    ],
  },
  {
    code: '49',
    name: 'Tỉnh Quảng Nam',
    districts: [
      {
        code: '503',
        name: 'Thành phố Hội An',
        wards: [
          { code: '20368', name: 'Phường Minh An' },
          { code: '20371', name: 'Phường Tân An' },
          { code: '20374', name: 'Phường Cẩm Phô' },
          { code: '20377', name: 'Phường Thanh Hà' },
          { code: '20380', name: 'Phường Sơn Phong' },
          { code: '20383', name: 'Phường Cẩm Châu' },
          { code: '20386', name: 'Phường Cửa Đại' },
          { code: '20389', name: 'Phường Cẩm An' },
          { code: '20392', name: 'Phường Cẩm Nam' },
        ],
      },
      {
        code: '502',
        name: 'Thành phố Tam Kỳ',
        wards: [
          { code: '20332', name: 'Phường Tân Thạnh' },
          { code: '20335', name: 'Phường Phước Hòa' },
          { code: '20338', name: 'Phường An Mỹ' },
          { code: '20341', name: 'Phường Hòa Hương' },
          { code: '20344', name: 'Phường An Xuân' },
          { code: '20347', name: 'Phường An Sơn' },
          { code: '20350', name: 'Phường Trường Xuân' },
          { code: '20353', name: 'Phường An Phú' },
          { code: '20356', name: 'Phường Hòa Thuận' },
        ],
      },
    ],
  },
  {
    code: '77',
    name: 'Tỉnh Bà Rịa - Vũng Tàu',
    districts: [
      {
        code: '747',
        name: 'Thành phố Vũng Tàu',
        wards: [
          { code: '26506', name: 'Phường 1' },
          { code: '26509', name: 'Phường Thắng Tam' },
          { code: '26512', name: 'Phường 2' },
          { code: '26515', name: 'Phường 3' },
          { code: '26518', name: 'Phường 4' },
          { code: '26521', name: 'Phường 5' },
          { code: '26524', name: 'Phường Thắng Nhì' },
          { code: '26527', name: 'Phường 7' },
          { code: '26530', name: 'Phường Nguyễn An Ninh' },
          { code: '26533', name: 'Phường 8' },
          { code: '26536', name: 'Phường 9' },
          { code: '26539', name: 'Phường Thắng Nhất' },
          { code: '26542', name: 'Phường Rạch Dừa' },
          { code: '26545', name: 'Phường 10' },
          { code: '26548', name: 'Phường 11' },
          { code: '26551', name: 'Phường 12' },
        ],
      },
      {
        code: '748',
        name: 'Thành phố Bà Rịa',
        wards: [
          { code: '26557', name: 'Phường Phước Hưng' },
          { code: '26560', name: 'Phường Phước Trung' },
          { code: '26563', name: 'Phường Phước Hiệp' },
          { code: '26566', name: 'Phường Phước Nguyên' },
          { code: '26569', name: 'Phường Long Hương' },
          { code: '26572', name: 'Phường Long Toàn' },
          { code: '26575', name: 'Phường Kim Dinh' },
          { code: '26578', name: 'Phường Long Tâm' },
        ],
      },
    ],
  },
  {
    code: '40',
    name: 'Tỉnh Nghệ An',
    districts: [
      {
        code: '412',
        name: 'Thành phố Vinh',
        wards: [
          { code: '16654', name: 'Phường Đông Vĩnh' },
          { code: '16657', name: 'Phường Hà Huy Tập' },
          { code: '16660', name: 'Phường Lê Lợi' },
          { code: '16663', name: 'Phường Quán Bàu' },
          { code: '16666', name: 'Phường Hưng Bình' },
          { code: '16669', name: 'Phường Hưng Phúc' },
          { code: '16672', name: 'Phường Hưng Dũng' },
          { code: '16675', name: 'Phường Cửa Nam' },
          { code: '16678', name: 'Phường Quang Trung' },
          { code: '16681', name: 'Phường Đội Cung' },
          { code: '16684', name: 'Phường Lê Mao' },
          { code: '16687', name: 'Phường Trường Thi' },
          { code: '16690', name: 'Phường Bến Thủy' },
          { code: '16693', name: 'Phường Hồng Sơn' },
          { code: '16696', name: 'Phường Trung Đô' },
          { code: '16699', name: 'Phường Vinh Tân' },
        ],
      },
    ],
  },
  {
    code: '38',
    name: 'Tỉnh Thanh Hóa',
    districts: [
      {
        code: '380',
        name: 'Thành phố Thanh Hóa',
        wards: [
          { code: '14755', name: 'Phường Hàm Rồng' },
          { code: '14758', name: 'Phường Đông Thọ' },
          { code: '14761', name: 'Phường Nam Ngạn' },
          { code: '14764', name: 'Phường Trường Thi' },
          { code: '14767', name: 'Phường Điện Biên' },
          { code: '14770', name: 'Phường Phú Sơn' },
          { code: '14773', name: 'Phường Lam Sơn' },
          { code: '14776', name: 'Phường Ba Đình' },
          { code: '14779', name: 'Phường Ngọc Trạo' },
          { code: '14782', name: 'Phường Đông Vệ' },
          { code: '14785', name: 'Phường Đông Sơn' },
          { code: '14788', name: 'Phường Tân Sơn' },
          { code: '14791', name: 'Phường Đông Hương' },
          { code: '14794', name: 'Phường Đông Hải' },
        ],
      },
    ],
  },
] as const;

function normalizeAdminLabel(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(
      /^(thanh pho|tp\.?|tinh|quan|q\.?|huyen|thi xa|tx\.?|phuong|p\.?|xa|thi tran)\s+/i,
      '',
    )
    .replace(/\s+/g, ' ')
    .trim();
}

export function getProvinceByCode(provinceCode: string): VnProvince | undefined {
  return VN_PROVINCES.find((p) => p.code === provinceCode);
}

export function getDistrictsByProvinceCode(
  provinceCode: string,
): readonly VnDistrict[] {
  return getProvinceByCode(provinceCode)?.districts ?? [];
}

export function getDistrictByCode(
  provinceCode: string,
  districtCode: string,
): VnDistrict | undefined {
  return getDistrictsByProvinceCode(provinceCode).find(
    (d) => d.code === districtCode,
  );
}

export function getWardsByDistrictCode(
  provinceCode: string,
  districtCode: string,
): readonly VnWard[] {
  return getDistrictByCode(provinceCode, districtCode)?.wards ?? [];
}

export function getWardByCode(
  provinceCode: string,
  districtCode: string,
  wardCode: string,
): VnWard | undefined {
  return getWardsByDistrictCode(provinceCode, districtCode).find(
    (w) => w.code === wardCode,
  );
}

export function getDefaultDivisionSelection(): VnDivisionSelection {
  const province = VN_PROVINCES[0]!;
  const district = province.districts[0]!;
  const ward = district.wards[0]!;
  return {
    provinceCode: province.code,
    provinceName: province.name,
    districtCode: district.code,
    districtName: district.name,
    wardCode: ward.code,
    wardName: ward.name,
  };
}

export function selectProvinceCascade(provinceCode: string): VnDivisionSelection {
  const province = getProvinceByCode(provinceCode) ?? VN_PROVINCES[0]!;
  const district = province.districts[0]!;
  const ward = district.wards[0]!;
  return {
    provinceCode: province.code,
    provinceName: province.name,
    districtCode: district.code,
    districtName: district.name,
    wardCode: ward.code,
    wardName: ward.name,
  };
}

export function selectDistrictCascade(
  provinceCode: string,
  districtCode: string,
): VnDivisionSelection {
  const province = getProvinceByCode(provinceCode) ?? VN_PROVINCES[0]!;
  const district =
    province.districts.find((d) => d.code === districtCode) ??
    province.districts[0]!;
  const ward = district.wards[0]!;
  return {
    provinceCode: province.code,
    provinceName: province.name,
    districtCode: district.code,
    districtName: district.name,
    wardCode: ward.code,
    wardName: ward.name,
  };
}

export function selectWardCascade(
  provinceCode: string,
  districtCode: string,
  wardCode: string,
): VnDivisionSelection {
  const province = getProvinceByCode(provinceCode) ?? VN_PROVINCES[0]!;
  const district =
    province.districts.find((d) => d.code === districtCode) ??
    province.districts[0]!;
  const ward =
    district.wards.find((w) => w.code === wardCode) ?? district.wards[0]!;
  return {
    provinceCode: province.code,
    provinceName: province.name,
    districtCode: district.code,
    districtName: district.name,
    wardCode: ward.code,
    wardName: ward.name,
  };
}

/**
 * Resolves official codes & canonical names from either existing codes or saved names
 * (supports legacy addresses whose names omit "Thành phố"/"Quận"/"Phường" prefixes).
 */
export function resolveDivisionSelection(input: {
  provinceCode?: string | null;
  provinceName?: string | null;
  districtCode?: string | null;
  districtName?: string | null;
  wardCode?: string | null;
  wardName?: string | null;
}): VnDivisionSelection | null {
  const province =
    (input.provinceCode ? getProvinceByCode(input.provinceCode.trim()) : undefined) ??
    (input.provinceName
      ? VN_PROVINCES.find(
          (p) =>
            normalizeAdminLabel(p.name) === normalizeAdminLabel(input.provinceName!),
        )
      : undefined);

  if (!province) {
    return null;
  }

  const district =
    (input.districtCode
      ? province.districts.find((d) => d.code === input.districtCode!.trim())
      : undefined) ??
    (input.districtName
      ? province.districts.find(
          (d) =>
            normalizeAdminLabel(d.name) === normalizeAdminLabel(input.districtName!),
        )
      : undefined) ??
    province.districts[0]!;

  const ward =
    (input.wardCode
      ? district.wards.find((w) => w.code === input.wardCode!.trim())
      : undefined) ??
    (input.wardName
      ? district.wards.find(
          (w) =>
            normalizeAdminLabel(w.name) === normalizeAdminLabel(input.wardName!),
        )
      : undefined) ??
    district.wards[0]!;

  return {
    provinceCode: province.code,
    provinceName: province.name,
    districtCode: district.code,
    districtName: district.name,
    wardCode: ward.code,
    wardName: ward.name,
  };
}
