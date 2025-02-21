# -*- coding: utf-8 -*-
# Part of Odoo. See LICENSE file for full copyright and licensing details.


{
    'name': 'Restaurant',
    'version': '1.0',
    'category': 'Sales/Point of Sale',
    'sequence': 6,
    'summary': 'Restaurant extensions for the Point of Sale ',
    'description': """

This module adds several features to the Point of Sale that are specific to restaurant management:
- Bill Printing: Allows you to print a receipt before the order is paid
- Bill Splitting: Allows you to split an order into different orders
- Kitchen Order Printing: allows you to print orders updates to kitchen or bar printers

""",
    'depends': ['point_of_sale'],
    'website': 'https://www.odoo.com/app/point-of-sale-restaurant',
    'data': [
        'security/ir.model.access.csv',
        'data/preset_data.xml',
        'views/pos_order_views.xml',
        'views/pos_restaurant_views.xml',
        'views/res_config_settings_views.xml',
    ],
    'demo': [
        'data/demo_data.xml',
    ],
    'installable': True,
    'application': True,
    'assets': {
        'point_of_sale._assets_pos': [
            'pos_restaurant/static/src/**/*',
            ('after', 'point_of_sale/static/src/scss/pos.scss', 'pos_restaurant/static/src/scss/restaurant.scss'),
        ],
        'web.assets_backend': [
            'point_of_sale/static/src/scss/pos_dashboard.scss',
        ],
        'web.assets_tests': [
            'pos_restaurant/static/tests/tours/**/*',
        ],
        'point_of_sale.assets_debug': [
            'pos_restaurant/static/tests/tours/**/*',
        ],
    },
    'license': 'LGPL-3',
}
